import numpy as np
import torch
import torch.nn as nn
import pickle, os, sys
from collections import Counter

# Add src to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

N_SAMPLES = 5000
WINDOW = 100
LOOK_AHEAD = 15
THRESHOLD = 0.001
BATCH_SIZE = 128
EPOCHS = 50
LR = 1e-3
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'model.onnx')
DATA_PATH = os.path.join(os.path.dirname(__file__), 'training_data.pkl')

def weighted_sampling(X, y, n_samples):
    """Oversample minority classes to balance dataset"""
    counts = Counter(y)
    max_count = max(counts.values())
    indices_by_class = {c: np.where(y == c)[0] for c in counts}
    sampled = []
    for c, idx in indices_by_class.items():
        repeats = max_count // len(idx)
        remainder = max_count % len(idx)
        for _ in range(repeats):
            sampled.extend(idx.tolist())
        sampled.extend(idx[:remainder].tolist())
    sampled = np.array(sampled)
    np.random.seed(42)
    np.random.shuffle(sampled)
    return X[sampled], y[sampled]

class TradingLSTM(nn.Module):
    def __init__(self, input_dim=12, hidden_dim=128, num_layers=2, dropout=0.3):
        super().__init__()
        self.lstm = nn.LSTM(input_dim, hidden_dim, num_layers, batch_first=True, dropout=dropout)
        self.head = nn.Sequential(
            nn.Linear(hidden_dim, 64),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(32, 3),
        )

    def forward(self, x):
        # x: (batch, window, features)
        lstm_out, (h_n, _) = self.lstm(x)
        last_hidden = h_n[-1]  # (batch, hidden_dim)
        logits = self.head(last_hidden)
        probs = torch.softmax(logits, dim=1)
        return logits, probs

def load_real_data():
    if not os.path.exists(DATA_PATH):
        print(f'No training data at {DATA_PATH}, generating synthetic...')
        return None, None
    with open(DATA_PATH, 'rb') as f:
        data = pickle.load(f)
    return data['X'], data['y']

def augment_with_synthetic(X, y, n_extra=3000):
    """Generate synthetic samples near real decision boundaries"""
    np.random.seed(99)
    longs = X[y == 0]
    shorts = X[y == 1]
    closes = X[y == 2]

    new_X, new_y = [], []

    for _ in range(n_extra):
        if len(longs) > 0:
            x = longs[np.random.randint(len(longs))]
            noise = x + np.random.randn(*x.shape) * 0.05
            new_X.append(noise)
            new_y.append(0)
        if len(shorts) > 0:
            x = shorts[np.random.randint(len(shorts))]
            noise = x + np.random.randn(*x.shape) * 0.05
            new_X.append(noise)
            new_y.append(1)
        if len(closes) > 0 and _ % 3 == 0:
            x = closes[np.random.randint(len(closes))]
            noise = x + np.random.randn(*x.shape) * 0.02
            new_X.append(noise)
            new_y.append(2)

    return np.concatenate([X, np.array(new_X, dtype=np.float32)]), np.concatenate([y, np.array(new_y, dtype=np.int64)])

def train():
    print('Loading real market data...')
    X_real, y_real = load_real_data()

    if X_real is not None:
        X_extra, y_extra = augment_with_synthetic(X_real, y_real, n_extra=5000)
        X, y = weighted_sampling(X_extra, y_extra, n_samples=len(y_extra))
        print(f'Dataset: {len(X)} samples after balancing')
        print(f'Label dist: long={np.sum(y==0)}, short={np.sum(y==1)}, close={np.sum(y==2)}')
    else:
        print('Generating synthetic data only...')
        np.random.seed(42)
        torch.manual_seed(42)
        base_price = 50000.0
        prices = base_price * np.exp(np.cumsum(np.random.randn(10000) * 0.003))
        from feature_engine import FeatureEngine
        engine = FeatureEngine(window_size=WINDOW, use_legacy_features=False)
        class MD:
            def __init__(self, p, v): self.lastPrice=p; self.bidPrice=p*0.9999; self.askPrice=p*1.0001; self.volume24h=v; self.timestamp=0
        X_list, y_list = [], []
        for i in range(len(prices) - WINDOW - LOOK_AHEAD - 1):
            window = [MD(prices[j], 100+50*np.random.rand()) for j in range(i, i+WINDOW)]
            feats = engine.compute(window).flatten()
            future = (prices[i+WINDOW+LOOK_AHEAD] - prices[i+WINDOW]) / prices[i+WINDOW]
            label = 0 if future > THRESHOLD else (1 if future < -THRESHOLD else 2)
            X_list.append(feats)
            y_list.append(label)
        X, y = np.array(X_list, dtype=np.float32), np.array(y_list, dtype=np.int64)
        X, y = weighted_sampling(X, y, len(y))

    # P0 Fix: Features are already stationary, no Z-Score normalization needed
    # Just ensure no NaN/Inf values
    X = np.nan_to_num(X, nan=0.0, posinf=1.0, neginf=-1.0)

    split = int(len(X) * 0.8)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]

    # Reshape for LSTM: (batch, window=1, features) since features already encode window info
    X_train_lstm = X_train[:, np.newaxis, :]
    X_test_lstm = X_test[:, np.newaxis, :]

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = TradingLSTM(input_dim=X_train.shape[1]).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)
    ce_loss = nn.CrossEntropyLoss(reduction='none')

    train_ds = torch.utils.data.TensorDataset(torch.from_numpy(X_train_lstm), torch.from_numpy(y_train))
    train_loader = torch.utils.data.DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True)

    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            logits, _ = model(xb)
            loss = ce_loss(logits, yb).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total_loss += loss.item()
        scheduler.step()

        if (epoch + 1) % 10 == 0:
            model.eval()
            with torch.no_grad():
                x_t = torch.from_numpy(X_test_lstm).to(device)
                logits, probs = model(x_t)
                preds = logits.argmax(dim=1).cpu().numpy()
                acc = (preds == y_test).mean()
                pred_dist = Counter(preds.tolist() if hasattr(preds, 'tolist') else preds)
                true_dist = Counter(y_test.tolist() if hasattr(y_test, 'tolist') else y_test)
            print(f'  Epoch {epoch+1:3d}/{EPOCHS}  loss={total_loss/len(train_loader):.4f}  test_acc={acc:.3f}  pred={dict(pred_dist)}  true={dict(true_dist)}')

    model.eval()
    with torch.no_grad():
        x_t = torch.from_numpy(X_test_lstm).to(device)
        logits, probs = model(x_t)
        preds = logits.argmax(dim=1).cpu().numpy()
        y_np = y_test.numpy() if hasattr(y_test, 'numpy') else y_test
        acc = (preds == y_np).mean()
    print(f'\nFinal test accuracy: {acc:.3f}')

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    export_to_onnx(model, device, X_train_lstm.shape[1], X_train_lstm.shape[2])
    print(f'Model saved to {MODEL_PATH}')
    verify_onnx(X_test_lstm, y_test)

def export_to_onnx(model, device, batch_size, input_dim):
    model.cpu()
    model.eval()

    class ExportModel(nn.Module):
        def __init__(self, m):
            super().__init__()
            self.model = m
        def forward(self, x):
            logits, probs = self.model(x)
            action = logits.argmax(dim=1, keepdim=True).to(torch.int64)
            confidence, _ = probs.max(dim=1, keepdim=True)
            return action, confidence

    export_model = ExportModel(model)
    dummy = torch.randn(batch_size, 1, input_dim, dtype=torch.float32)
    torch.onnx.export(
        export_model, dummy, MODEL_PATH,
        input_names=['features'],
        output_names=['action', 'confidence'],
        opset_version=17,
        dynamo=False,
    )

def verify_onnx(X_test, y_test):
    import onnxruntime as ort
    session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
    input_name = session.get_inputs()[0].name
    correct = 0
    for i in range(min(500, len(X_test))):
        inp = X_test[i:i+1].astype(np.float32)
        result = session.run(None, {input_name: inp})
        if isinstance(result[0], dict):
            action_idx = int(result[0]['action'][0])
            confidence = float(result[0]['confidence'][0]) * 100
        else:
            action_idx = int(result[0][0, 0])
            confidence = float(result[1][0, 0]) * 100
        y_val = y_test[i]
        if action_idx == int(y_val):
            correct += 1
    print(f'ONNX verification: {correct}/500 correct ({correct/500:.1%})')

if __name__ == '__main__':
    train()
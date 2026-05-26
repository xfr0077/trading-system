import numpy as np
import torch
import torch.nn as nn
import pickle, os, sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

BATCH_SIZE = 64
EPOCHS = 150
LR = 5e-4
PATIENCE = 20
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models', 'model.onnx')
DATA_PATH = os.path.join(os.path.dirname(__file__), 'training_data.pkl')


def compute_class_weights(y):
    counts = Counter(y)
    total = len(y)
    n_classes = len(counts)
    weights = [total / (n_classes * counts[c]) for c in sorted(counts.keys())]
    return torch.tensor(weights, dtype=torch.float32)


class TradingLSTM(nn.Module):
    def __init__(self, input_dim=12, hidden_dim=256, num_layers=3, dropout=0.25):
        super().__init__()
        self.lstm = nn.LSTM(input_dim, hidden_dim, num_layers,
                           batch_first=True, dropout=dropout)
        self.head = nn.Sequential(
            nn.Linear(hidden_dim, 128),
            nn.LayerNorm(128),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(64, 3),
        )

    def forward(self, x):
        lstm_out, (h_n, _) = self.lstm(x)
        last_hidden = h_n[-1]
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


def train():
    print('Loading real market data...')
    X_real, y_real = load_real_data()

    if X_real is None:
        print('No real data found, exiting.')
        return

    X, y = X_real, y_real
    print(f'Dataset: {len(X)} raw samples')
    print(f'Label dist: long={np.sum(y==0)}, short={np.sum(y==1)}, close={np.sum(y==2)}')

    X = np.nan_to_num(X, nan=0.0, posinf=1.0, neginf=-1.0)

    from sklearn.model_selection import train_test_split
    X_temp, X_test, y_temp, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y)
    X_train, X_val, y_train, y_val = train_test_split(
        X_temp, y_temp, test_size=0.125, random_state=42, stratify=y_temp)

    print(f'Train: {len(X_train)}, Val: {len(X_val)}, Test: {len(X_test)}')
    print(f'Train dist: {dict(Counter(y_train.tolist()))}')

    X_train_lstm = X_train[:, np.newaxis, :]
    X_val_lstm = X_val[:, np.newaxis, :]
    X_test_lstm = X_test[:, np.newaxis, :]

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = TradingLSTM(input_dim=X_train.shape[1]).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=EPOCHS)

    class_weights = compute_class_weights(y_train).to(device)
    print(f'Class weights: {class_weights.cpu().numpy()}')
    ce_loss = nn.CrossEntropyLoss(weight=class_weights, reduction='mean')

    train_ds = torch.utils.data.TensorDataset(
        torch.from_numpy(X_train_lstm), torch.from_numpy(y_train))
    train_loader = torch.utils.data.DataLoader(
        train_ds, batch_size=BATCH_SIZE, shuffle=True)

    best_val_acc = 0
    best_state = None
    epochs_no_improve = 0

    for epoch in range(EPOCHS):
        model.train()
        total_loss = 0
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            logits, _ = model(xb)
            loss = ce_loss(logits, yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total_loss += loss.item()
        scheduler.step()

        if (epoch + 1) % 5 == 0:
            model.eval()
            with torch.no_grad():
                x_v = torch.from_numpy(X_val_lstm).to(device)
                logits_v, probs_v = model(x_v)
                preds_v = logits_v.argmax(dim=1).cpu().numpy()
                val_acc = (preds_v == y_val).mean()

                x_t = torch.from_numpy(X_test_lstm).to(device)
                logits_t, _ = model(x_t)
                preds_t = logits_t.argmax(dim=1).cpu().numpy()
                test_acc = (preds_t == y_test).mean()

            prefix = ''
            if val_acc > best_val_acc:
                best_val_acc = val_acc
                best_state = model.state_dict()
                epochs_no_improve = 0
                prefix = ' *'
            else:
                epochs_no_improve += 1

            print(f'  Epoch {epoch+1:3d}/{EPOCHS}  loss={total_loss/len(train_loader):.4f}  '
                  f'val_acc={val_acc:.3f}  test_acc={test_acc:.3f}{prefix}')

            if epochs_no_improve >= PATIENCE:
                print(f'  Early stopping at epoch {epoch+1}')
                break

    if best_state is not None:
        model.load_state_dict(best_state)
        print(f'Restored best model (val_acc={best_val_acc:.3f})')

    model.eval()
    with torch.no_grad():
        x_t = torch.from_numpy(X_test_lstm).to(device)
        logits, probs = model(x_t)
        preds = logits.argmax(dim=1).cpu().numpy()
        acc = (preds == y_test).mean()
        print(f'\nFinal test accuracy: {acc:.3f}')

        for cls_name, cls_idx in [('long', 0), ('short', 1), ('close', 2)]:
            mask = y_test == cls_idx
            if mask.sum() > 0:
                cls_acc = (preds[mask] == y_test[mask]).mean()
                print(f'  {cls_name} accuracy: {cls_acc:.3f} ({mask.sum()} samples)')

        pred_dist = Counter(preds.tolist())
        true_dist = Counter(y_test.tolist())
        print(f'  Pred dist: {dict(pred_dist)}')
        print(f'  True dist: {dict(true_dist)}')

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    export_to_onnx(model, device, X_train_lstm.shape[1], X_train_lstm.shape[2])
    print(f'Model saved to {MODEL_PATH}')
    verify_onnx(X_test_lstm, y_test)
    calibration_analysis(X_test_lstm, y_test)


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


def calibration_analysis(X_test, y_test, n_bins=10):
    import onnxruntime as ort
    session = ort.InferenceSession(MODEL_PATH, providers=['CPUExecutionProvider'])
    input_name = session.get_inputs()[0].name

    probs_list = []
    correct_list = []
    for i in range(len(X_test)):
        inp = X_test[i:i+1].astype(np.float32)
        result = session.run(None, {input_name: inp})
        if isinstance(result[1], dict):
            confidence = float(result[1]['confidence'][0])
        else:
            confidence = float(result[1][0, 0])
        if isinstance(result[0], dict):
            action_idx = int(result[0]['action'][0])
        else:
            action_idx = int(result[0][0, 0])
        probs_list.append(confidence)
        correct_list.append(1 if action_idx == int(y_test[i]) else 0)

    probs = np.array(probs_list)
    correct = np.array(correct_list)

    bins = np.linspace(0, 1, n_bins + 1)
    bin_accs = []
    bin_confs = []
    bin_counts = []
    for i in range(n_bins):
        in_bin = (probs >= bins[i]) & (probs < bins[i + 1])
        count = in_bin.sum()
        bin_counts.append(count)
        if count > 0:
            bin_accs.append(correct[in_bin].mean())
            bin_confs.append(probs[in_bin].mean())
        else:
            bin_accs.append(0)
            bin_confs.append((bins[i] + bins[i + 1]) / 2)

    ece = sum(bin_counts[i] * abs(bin_accs[i] - bin_confs[i]) for i in range(n_bins)) / len(probs)
    print(f'\nCalibration Analysis (ONNX):')
    print(f'  ECE: {ece:.4f}')
    for i in range(n_bins):
        if bin_counts[i] > 0:
            print(f'  bin [{bins[i]:.2f},{bins[i+1]:.2f}): n={bin_counts[i]:4d}  '
                  f'acc={bin_accs[i]:.3f}  conf={bin_confs[i]:.3f}  '
                  f'gap={abs(bin_accs[i]-bin_confs[i]):.3f}')

    # Threshold sweep
    print(f'\nThreshold sweep:')
    thresholds = [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9]
    for thresh in thresholds:
        filtered = probs >= thresh
        if filtered.sum() > 0:
            acc = correct[filtered].mean()
            print(f'  threshold={thresh:.2f}: n={filtered.sum():4d}  acc={acc:.3f}')
        else:
            print(f'  threshold={thresh:.2f}: n=0')

    return ece


if __name__ == '__main__':
    train()

import numpy as np
import onnxruntime

ACTION_MAP = {0: "long", 1: "short", 2: "close"}

class ModelInference:
    def __init__(self, model_path: str, confidence_threshold: float = 70.0):
        self.session = onnxruntime.InferenceSession(
            model_path,
            providers=['CPUExecutionProvider']
        )
        self._confidence_threshold = confidence_threshold
        self._input_name = self.session.get_inputs()[0].name

    def predict(self, features: np.ndarray) -> tuple:
        # features: (batch, features) -> reshape to (batch, 1, features) for LSTM
        if features.ndim == 2:
            features = features[:, np.newaxis, :]
        if features.shape[0] == 0:
            return None, 0.0
        result = self.session.run(None, {self._input_name: features.astype(np.float32)})
        if isinstance(result[0], dict):
            action_idx = int(result[0]['action'][0])
            confidence = float(result[0]['confidence'][0]) * 100
        else:
            action_idx = int(result[0][0, 0])
            confidence = float(result[1][0, 0]) * 100

        action = ACTION_MAP.get(action_idx)

        if confidence < self._confidence_threshold:
            return None, confidence

        return action, confidence

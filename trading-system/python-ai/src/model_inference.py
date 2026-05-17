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
        result = self.session.run(None, {self._input_name: features})
        action_idx = int(result[0]['action'][0])
        confidence = float(result[0]['confidence'][0]) * 100

        action = ACTION_MAP.get(action_idx)

        if confidence < self._confidence_threshold:
            return None, confidence

        return action, confidence

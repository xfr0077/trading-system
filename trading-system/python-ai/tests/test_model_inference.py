import numpy as np
import pytest
from unittest.mock import MagicMock, patch
from src.model_inference import ModelInference

@pytest.fixture
def mock_session():
    session = MagicMock()
    session.get_inputs.return_value = [MagicMock(name='input', shape=[1, 10])]
    session.run.return_value = [{'action': np.array([0]), 'confidence': np.array([0.75])}]
    return session

def test_predict_returns_action_and_confidence(mock_session):
    with patch('onnxruntime.InferenceSession', return_value=mock_session):
        inference = ModelInference("models/test.onnx")
        features = np.random.randn(1, 10).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action in ("long", "short", "close")
        assert 0.0 <= confidence <= 100.0

def test_predict_below_threshold(mock_session):
    mock_session.run.return_value = [{'action': np.array([0]), 'confidence': np.array([0.50])}]
    with patch('onnxruntime.InferenceSession', return_value=mock_session):
        inference = ModelInference("models/test.onnx", confidence_threshold=70.0)
        features = np.random.randn(1, 10).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action is None
        assert confidence == 50.0

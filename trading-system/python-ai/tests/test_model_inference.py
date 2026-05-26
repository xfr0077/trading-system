import numpy as np
import pytest
from unittest.mock import MagicMock, patch
from src.model_inference import ModelInference

@pytest.fixture
def mock_session_dict():
    session = MagicMock()
    session.get_inputs.return_value = [MagicMock(name='input', shape=[1, 1, 12])]
    session.get_inputs.return_value[0].name = 'features'
    session.run.return_value = [{'action': np.array([0]), 'confidence': np.array([0.75])}]
    return session

@pytest.fixture
def mock_session_tensor():
    session = MagicMock()
    session.get_inputs.return_value = [MagicMock(name='input', shape=[1, 1, 12])]
    session.get_inputs.return_value[0].name = 'features'
    session.run.return_value = [np.array([[0]]), np.array([[0.75]])]
    return session

# -- Dict format tests (original ONNX export) --

def test_predict_returns_action_and_confidence_dict(mock_session_dict):
    with patch('onnxruntime.InferenceSession', return_value=mock_session_dict):
        inference = ModelInference("models/test.onnx")
        features = np.random.randn(1, 12).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action in ("long", "short", "close")
        assert 0.0 <= confidence <= 100.0

def test_predict_below_threshold_dict(mock_session_dict):
    mock_session_dict.run.return_value = [{'action': np.array([0]), 'confidence': np.array([0.50])}]
    with patch('onnxruntime.InferenceSession', return_value=mock_session_dict):
        inference = ModelInference("models/test.onnx", confidence_threshold=70.0)
        features = np.random.randn(1, 12).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action is None
        assert confidence == 50.0

# -- Tensor format tests (common ONNX export) --

def test_predict_returns_action_and_confidence_tensor(mock_session_tensor):
    with patch('onnxruntime.InferenceSession', return_value=mock_session_tensor):
        inference = ModelInference("models/test.onnx")
        features = np.random.randn(1, 12).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action in ("long", "short", "close")
        assert 0.0 <= confidence <= 100.0

def test_predict_tensor_below_threshold(mock_session_tensor):
    mock_session_tensor.run.return_value = [np.array([[0]]), np.array([[0.50]])]
    with patch('onnxruntime.InferenceSession', return_value=mock_session_tensor):
        inference = ModelInference("models/test.onnx", confidence_threshold=70.0)
        features = np.random.randn(1, 12).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action is None
        assert confidence == 50.0

# -- 3D input tests --

def test_predict_with_3d_input(mock_session_dict):
    with patch('onnxruntime.InferenceSession', return_value=mock_session_dict):
        inference = ModelInference("models/test.onnx")
        features = np.random.randn(1, 1, 12).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action == "long"

# -- Action mapping tests --

def test_action_mapping_all_values(mock_session_dict):
    actions = {0: "long", 1: "short", 2: "close"}
    for action_idx, expected in actions.items():
        mock_session_dict.run.return_value = [{'action': np.array([action_idx]), 'confidence': np.array([0.80])}]
        with patch('onnxruntime.InferenceSession', return_value=mock_session_dict):
            inference = ModelInference("models/test.onnx")
            features = np.random.randn(1, 12).astype(np.float32)
            action, _ = inference.predict(features)
            assert action == expected

# -- Threshold boundary tests --

def test_predict_at_threshold_boundary(mock_session_dict):
    mock_session_dict.run.return_value = [{'action': np.array([0]), 'confidence': np.array([0.70])}]
    with patch('onnxruntime.InferenceSession', return_value=mock_session_dict):
        inference = ModelInference("models/test.onnx", confidence_threshold=70.0)
        features = np.random.randn(1, 12).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action == "long"
        assert confidence == 70.0

def test_predict_just_below_threshold(mock_session_dict):
    mock_session_dict.run.return_value = [{'action': np.array([0]), 'confidence': np.array([0.699])}]
    with patch('onnxruntime.InferenceSession', return_value=mock_session_dict):
        inference = ModelInference("models/test.onnx", confidence_threshold=70.0)
        features = np.random.randn(1, 12).astype(np.float32)
        action, _ = inference.predict(features)
        assert action is None

# -- Error handling tests --

def test_predict_with_missing_model():
    with pytest.raises(Exception):
        inference = ModelInference("models/nonexistent.onnx")
        features = np.random.randn(1, 12).astype(np.float32)
        inference.predict(features)

def test_predict_with_empty_features(mock_session_dict):
    with patch('onnxruntime.InferenceSession', return_value=mock_session_dict):
        inference = ModelInference("models/test.onnx")
        features = np.empty((0, 12), dtype=np.float32)
        action, confidence = inference.predict(features)
        assert action is None

# -- Batch size handling --

def test_predict_batch_first_element(mock_session_dict):
    mock_session_dict.run.return_value = [{'action': np.array([2]), 'confidence': np.array([0.85])}]
    with patch('onnxruntime.InferenceSession', return_value=mock_session_dict):
        inference = ModelInference("models/test.onnx")
        features = np.random.randn(3, 12).astype(np.float32)
        action, _ = inference.predict(features)
        assert action == "close"

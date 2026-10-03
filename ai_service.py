"""
Neuro-Focus AI Engine - Phase 2 Microservice
Handles attention score prediction using sequential behavioral features.
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
import numpy as np

app = FastAPI(
    title="Neuro-Focus AI Prediction Service",
    description="FastAPI service for processing gaze & head-pose vectors with LSTM architecture",
    version="2.0.0"
)

# Request schema representing sliding window of behavioral frames from MediaPipe
class LandmarkFeatureWindow(BaseModel):
    session_id: str
    student_id: str
    gaze_ratios: List[float]       # Sliding window of eye ratios
    head_yaw_pitch_roll: List[List[float]] = [] # Angular orientation per frame

class PredictionResponse(BaseModel):
    session_id: str
    student_id: str
    attention_score: float
    engagement_state: str          # "Focused" or "Distracted"
    trigger_alert: bool

@app.get("/")
def health_check():
    return {
        "service": "Neuro-Focus AI Prediction Engine",
        "status": "online",
        "model_architecture": "LSTM Recurrent Neural Network",
        "hardware_acceleration": "CUDA / RTX 3070 target"
    }

@app.post("/api/predict-attention", response_model=PredictionResponse)
def predict_attention(payload: LandmarkFeatureWindow):
    if not payload.gaze_ratios:
        raise HTTPException(status_code=400, detail="Empty feature window provided.")

    # Demonstration logic simulating Phase 2 LSTM inference
    mean_gaze = np.mean(payload.gaze_ratios)
    
    # Calculate score based on center eye gaze stability
    deviation = abs(0.5 - mean_gaze)
    simulated_lstm_score = max(0.0, min(1.0, 1.0 - (deviation * 2.2)))
    
    state = "Focused" if simulated_lstm_score >= 0.60 else "Distracted"
    alert = state == "Distracted"

    return PredictionResponse(
        session_id=payload.session_id,
        student_id=payload.student_id,
        attention_score=round(float(simulated_lstm_score), 2),
        engagement_state=state,
        trigger_alert=alert
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001)
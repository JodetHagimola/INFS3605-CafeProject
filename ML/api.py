
from datetime import date
import subprocess
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict

app = FastAPI()


class ForecastRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    forecast_date: date
    is_public_holiday: bool


# Allow the local Next.js website to communicate with Python
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

@app.get("/")
def home():
    return {"message": "Cafe AI API is running!"}


@app.get("/recommendations")
def get_recommendations():
    project_root = Path(__file__).resolve().parents[1]

    result = subprocess.run(
        [
            sys.executable,
            str(project_root / "ML" / "data" / "calculate_ingredients.py")
        ],
        cwd=project_root,
        capture_output=True,
        text=True,
        timeout=60
    )

    if result.returncode != 0:
        return {
            "status": "error",
            "message": result.stderr
        }

    return {
        "status": "success",
        "recommendations": result.stdout
    }


@app.post("/forecast")
def get_forecast(request: ForecastRequest):
    try:
        from ML.data.agent_forecast import forecast_drink_sales

        return {
            "status": "success",
            **forecast_drink_sales(request.forecast_date, request.is_public_holiday),
        }
    except Exception as error:
        print(f"Forecast model failed: {error}", file=sys.stderr)
        raise HTTPException(
            status_code=500,
            detail="The saved forecast model could not produce a forecast.",
        ) from error

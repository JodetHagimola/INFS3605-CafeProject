
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

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


import subprocess
import sys
from pathlib import Path

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

from datetime import date
import math
from pathlib import Path

import joblib
import pandas as pd


PRODUCTS = ["Latte", "Cappuccino", "Flat White", "Long Black", "Mocha"]


def forecast_drink_sales(forecast_date: date, is_public_holiday: bool) -> dict:
    model_path = Path(__file__).resolve().parents[1] / "forecast_model.joblib"
    if not model_path.is_file():
        raise FileNotFoundError("The saved forecast model is missing.")

    saved = joblib.load(model_path)
    model = saved["model"]
    columns = saved["columns"]
    features = saved["features"]

    future = pd.DataFrame({
        "product_name": PRODUCTS,
        "day_number": [forecast_date.weekday()] * len(PRODUCTS),
        "month": [forecast_date.month] * len(PRODUCTS),
        "holiday": [int(is_public_holiday)] * len(PRODUCTS),
    })
    inputs = pd.get_dummies(future[features], columns=["product_name"], dtype=int)
    inputs = inputs.reindex(columns=columns, fill_value=0)
    predictions = model.predict(inputs)

    predicted_sales = {}
    for product, prediction in zip(PRODUCTS, predictions):
        value = float(prediction)
        if not math.isfinite(value):
            raise ValueError("The forecast model returned an invalid prediction.")
        predicted_sales[product] = max(0, round(value))

    return {
        "forecastDate": forecast_date.isoformat(),
        "isPublicHoliday": is_public_holiday,
        "predictedSales": predicted_sales,
        "source": "Saved model trained on synthetic sales data",
    }

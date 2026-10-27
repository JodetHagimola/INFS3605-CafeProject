"""Forecast daily drink sales using the trained café Random Forest model.

Place this file in ML/data/ alongside train_model.py, then run:
    python ML/data/predict.py
"""
from pathlib import Path
import joblib
import pandas as pd

folder = Path(__file__).resolve().parent
model_path = folder.parent / 'forecast_model.joblib'

if not model_path.exists():
    raise FileNotFoundError('Model not found. Run python ML/data/train_model.py first.')

saved = joblib.load(model_path)
model = saved['model']
columns = saved['columns']
features = saved['features']

# Change this date to the day you want to forecast.
forecast_date = pd.Timestamp('2026-10-26')

# Set to 1 for a NSW public holiday, otherwise 0.
# Check the actual holiday calendar for the date you choose.
is_public_holiday = 0

products = ['Latte', 'Cappuccino', 'Flat White', 'Long Black', 'Mocha']

future = pd.DataFrame({
    'product_name': products,
    'day_number': [forecast_date.dayofweek] * len(products),
    'month': [forecast_date.month] * len(products),
    'holiday': [is_public_holiday] * len(products),
})

# Use the same features and exact column order as training.
X_future = pd.get_dummies(future[features], columns=['product_name'], dtype=int)
X_future = X_future.reindex(columns=columns, fill_value=0)

predictions = model.predict(X_future)

print(f'\nPredicted drink sales for {forecast_date.date()}')
print('-' * 45)
for product, value in zip(products, predictions):
    print(f'{product:15s} {max(0, round(float(value))):4d} drinks')
print('-' * 45)
print('Forecasts are based on synthetic historical data.')

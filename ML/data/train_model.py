from pathlib import Path

import joblib
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import ParameterGrid

# The CSV is in the same folder as this script: ML/data/
folder = Path(__file__).resolve().parent
csv_path = folder / 'cafe_sales_2023_2025_synthetic_nsw.csv'
df = pd.read_csv(csv_path, parse_dates=['date'])

# Only use information that is known in advance when forecasting.
df['day_number'] = df['date'].dt.dayofweek
df['month'] = df['date'].dt.month
df['holiday'] = df['is_public_holiday'].astype(int)

# Chronological split: select settings on 2024, evaluate once on 2025.
train = df['date'] < '2024-07-01'
validation = (df['date'] >= '2024-07-01') & (df['date'] < '2025-01-01')
development = df['date'] < '2025-01-01'
test = df['date'] >= '2025-01-01'

feature_sets = {
    'without_month': ['product_name', 'day_number', 'holiday'],
    'with_month': ['product_name', 'day_number', 'month', 'holiday'],
}

parameter_grid = {
    'n_estimators': [100, 200],
    'max_depth': [5, 10, None],
    'min_samples_leaf': [2, 5, 10],
}

print(f'Dataset loaded: {len(df):,} records')
print(f'Training rows: {train.sum():,}; validation rows: {validation.sum():,}; test rows: {test.sum():,}')

best = None
for feature_name, features in feature_sets.items():
    X = pd.get_dummies(df[features], columns=['product_name'], dtype=int)
    y = df['quantity_sold']
    for params in ParameterGrid(parameter_grid):
        model = RandomForestRegressor(**params, random_state=42, n_jobs=-1)
        model.fit(X.loc[train], y.loc[train])
        validation_predictions = model.predict(X.loc[validation])
        validation_mae = mean_absolute_error(y.loc[validation], validation_predictions)
        if best is None or validation_mae < best['mae']:
            best = {'mae': validation_mae, 'features': features, 'name': feature_name, 'params': params}

print(f'\nBest validation MAE: {best["mae"]:.2f} drinks')
print(f'Best feature set: {best["name"]}')
print(f'Best Random Forest settings: {best["params"]}')

# Fit on all of 2023–2024 and evaluate on untouched 2025 data.
X = pd.get_dummies(df[best['features']], columns=['product_name'], dtype=int)
y = df['quantity_sold']
model = RandomForestRegressor(**best['params'], random_state=42, n_jobs=-1)
model.fit(X.loc[development], y.loc[development])
predictions = model.predict(X.loc[test])
rf_mae = mean_absolute_error(y.loc[test], predictions)

# Simple benchmark: average 2023–2024 sales per product.
product_averages = df.loc[development].groupby('product_name')['quantity_sold'].mean()
baseline_predictions = df.loc[test, 'product_name'].map(product_averages)
baseline_mae = mean_absolute_error(y.loc[test], baseline_predictions)

# Stronger benchmark: average 2023–2024 sales per product and weekday.
weekday_averages = df.loc[development].groupby(['product_name', 'day_number'])['quantity_sold'].mean()
test_keys = pd.MultiIndex.from_frame(df.loc[test, ['product_name', 'day_number']])
weekday_predictions = pd.Series(weekday_averages.reindex(test_keys).to_numpy(), index=df.index[test])
weekday_predictions = weekday_predictions.fillna(baseline_predictions)
weekday_mae = mean_absolute_error(y.loc[test], weekday_predictions)

print('\nFINAL RESULTS — 2025 TEST SET')
print(f'Random Forest MAE: {rf_mae:.2f} drinks')
print(f'Product average baseline MAE: {baseline_mae:.2f} drinks')
print(f'Product + weekday baseline MAE: {weekday_mae:.2f} drinks')

# Save the model and its exact input columns for the prediction script.
output_path = folder.parent / 'forecast_model.joblib'
joblib.dump({'model': model, 'columns': X.columns.tolist(), 'features': best['features']}, output_path)
print(f'\nModel saved to: {output_path}')

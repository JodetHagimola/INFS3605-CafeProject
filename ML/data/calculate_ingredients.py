
from pathlib import Path
import os
import pandas as pd
import joblib

from dotenv import load_dotenv
from supabase import create_client

# Load environment variables from project root
project_root = Path(__file__).resolve().parents[2]
load_dotenv(project_root / ".env")

url = os.environ["SUPABASE_URL"]
key = os.environ["SUPABASE_KEY"]

supabase = create_client(url, key)

# Load the trained AI model
saved = joblib.load(
    project_root / "ML" / "forecast_model.joblib"
)

model = saved["model"]
columns = saved["columns"]

# Date to forecast
forecast_date = pd.Timestamp("2026-10-26")
is_public_holiday = 0

products = [
    "Latte",
    "Cappuccino",
    "Flat White",
    "Long Black",
    "Mocha"
]

# Generate AI sales predictions
future = pd.DataFrame({
    "product_name": products,
    "day_number": [forecast_date.dayofweek] * len(products),
    "month": [forecast_date.month] * len(products),
    "holiday": [is_public_holiday] * len(products)
})

X_future = pd.get_dummies(
    future,
    columns=["product_name"]
)

X_future = X_future.reindex(
    columns=columns,
    fill_value=0
)

predictions = model.predict(X_future)

predicted_sales = {
    product: max(0, round(float(value)))
    for product, value in zip(products, predictions)
}

# Retrieve recipe data from Supabase
recipes_response = (
    supabase.table("recipes")
    .select("product_name,ingredient_id,quantity_required")
    .execute()
)

ingredients_response = (
    supabase.table("ingredients")
    .select("ingredient_id,ingredient_name,unit")
    .execute()
)

recipes = recipes_response.data
ingredients = ingredients_response.data

if not recipes or not ingredients:
    raise ValueError(
        "No recipe or ingredient data returned. "
        "Check Supabase tables and RLS policies."
    )

ingredient_lookup = {
    item["ingredient_id"]: item
    for item in ingredients
}

totals = {}

# Calculate requirements
for recipe in recipes:
    product = recipe["product_name"]

    if product not in predicted_sales:
        continue

    ingredient_id = recipe["ingredient_id"]

    if ingredient_id not in ingredient_lookup:
        raise ValueError(
            f"Missing ingredient ID: {ingredient_id}"
        )

    ingredient = ingredient_lookup[ingredient_id]
    quantity = (
        predicted_sales[product]
        * float(recipe["quantity_required"])
    )

    totals[ingredient_id] = (
        totals.get(ingredient_id, 0) + quantity
    )

# Display results
print(f"\nINGREDIENT REQUIREMENTS: {forecast_date.date()}")
print("-" * 48)

print("\nPredicted drink sales:")
for product, quantity in predicted_sales.items():
    print(f"  {product}: {quantity} drinks")

print("\nRequired ingredients:")
for ingredient_id, quantity in totals.items():
    ingredient = ingredient_lookup[ingredient_id]
    name = ingredient["ingredient_name"]
    unit = ingredient["unit"]

    if unit.lower() == "ml":
        print(f"  {name}: {quantity / 1000:.2f} L")
    elif unit.lower() == "g":
        print(f"  {name}: {quantity / 1000:.2f} kg")
    else:
        print(f"  {name}: {quantity:.2f} {unit}")

        
# Retrieve current inventory from Supabase
inventory_response = (
    supabase.table("inventory")
    .select("ingredient_id,quantity_in_stock")
    .execute()
)

inventory = inventory_response.data

if not inventory:
    raise ValueError(
        "No inventory data returned. Check the inventory table."
    )

# Match inventory quantities to ingredient IDs
stock_lookup = {
    item["ingredient_id"]: float(item["quantity_in_stock"])
    for item in inventory
}

# Calculate and display order recommendations
print("\nAUTOMATED ORDER RECOMMENDATIONS")
print("-" * 48)

for ingredient_id, required in totals.items():
    ingredient = ingredient_lookup[ingredient_id]
    name = ingredient["ingredient_name"]
    unit = ingredient["unit"]

    if ingredient_id not in stock_lookup:
        raise ValueError(
            f"Missing inventory record for {name}"
        )

    available = stock_lookup[ingredient_id]

    # Order only the additional quantity needed
    order_quantity = max(0, required - available)

    # Display quantities in readable units
    if unit.lower() == "ml":
        display_unit = "L"
        divisor = 1000
    elif unit.lower() == "g":
        display_unit = "kg"
        divisor = 1000
    else:
        display_unit = unit
        divisor = 1

    print(f"\n{name}")
    print(f"  Required: {required / divisor:.2f} {display_unit}")
    print(f"  In stock: {available / divisor:.2f} {display_unit}")
    print(
        f"  Recommended order: "
        f"{order_quantity / divisor:.2f} {display_unit}"
    )

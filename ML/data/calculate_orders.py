
# Sample inventory quantities
# These match the example records in Supabase
inventory = {
    "Milk": 20000,             # mL
    "Coffee Beans": 3000,      # g
    "Chocolate Powder": 1500   # g
}

# Ingredient requirements from the AI forecast
# Temporary values; we'll automate these next
requirements = {
    "Milk": 49720,             # mL
    "Coffee Beans": 5508,      # g
    "Chocolate Powder": 720    # g
}

print("\nAUTOMATED ORDER RECOMMENDATIONS")
print("-" * 55)

for ingredient, required in requirements.items():
    available = inventory.get(ingredient, 0)

    order_quantity = max(0, required - available)

    # Convert units for display
    if ingredient == "Milk":
        unit = "L"
    else:
        unit = "kg"

    print(f"\n{ingredient}")
    print(f"  Required: {required / 1000:.2f} {unit}")
    print(f"  Available: {available / 1000:.2f} {unit}")
    print(f"  Recommended order: {order_quantity / 1000:.2f} {unit}")

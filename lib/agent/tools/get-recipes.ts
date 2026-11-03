import { tool } from "ai";
import { z } from "zod";
import { idValue, nonnegativeNumber, readAll, textValue } from "./shared";
import { withAgentActivity } from "./activity";

export const getRecipesTool = tool({
  description: "Read drink recipes and ingredient names, units, and quantities per drink.",
  inputSchema: z.object({}).strict(),
  execute: async (input) => withAgentActivity("get_recipes", input, async () => {
    const [ingredients, recipes] = await Promise.all([
      readAll("ingredients", "ingredient_id,ingredient_name,unit"),
      readAll("recipes", "product_name,ingredient_id,quantity_required"),
    ]);
    const ingredientsById = new Map(ingredients.map((row) => [
      idValue(row.ingredient_id, "Ingredient ID"),
      {
        id: idValue(row.ingredient_id, "Ingredient ID"),
        name: textValue(row.ingredient_name, "Ingredient name"),
        unit: textValue(row.unit, "Ingredient unit"),
      },
    ]));
    if (!recipes.length) throw new Error("The recipes table is empty.");

    return recipes.map((row) => {
      const product = textValue(row.product_name, "Recipe product name");
      const ingredientId = idValue(row.ingredient_id, "Recipe ingredient ID");
      const ingredient = ingredientsById.get(ingredientId);
      if (!ingredient) throw new Error(`Recipe data for ${product} refers to an unknown ingredient.`);
      const quantityPerDrink = nonnegativeNumber(row.quantity_required, `Recipe quantity for ${product}`);
      if (quantityPerDrink === 0) throw new Error(`Recipe quantity for ${product} must be positive.`);
      return { product, ingredient, quantityPerDrink };
    });
  }),
});

import { readFileSync } from 'node:fs';
import { recipeHash, validateRecipe } from './schema.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function createRegistry(rawRecipes) {
  if (!Array.isArray(rawRecipes)) throw new Error('capture recipe registry must be an array');
  const ids = new Set();
  const entries = rawRecipes.map((raw, index) => {
    let recipe;
    try {
      recipe = validateRecipe(structuredClone(raw));
    } catch (error) {
      throw new Error(`capture recipe registry entry ${index}: ${error.message}`, { cause: error });
    }
    if (ids.has(recipe.id)) throw new Error(`duplicate capture recipe ID '${recipe.id}'`);
    ids.add(recipe.id);
    return deepFreeze({ recipe: deepFreeze(recipe), hash: recipeHash(recipe) });
  });
  return Object.freeze(entries);
}

const raw = JSON.parse(readFileSync(new URL('./recipes.json', import.meta.url), 'utf8'));
export const CAPTURE_RECIPES = createRegistry(raw);

export function findRecipe(id) {
  return CAPTURE_RECIPES.find((entry) => entry.recipe.id === id) ?? null;
}

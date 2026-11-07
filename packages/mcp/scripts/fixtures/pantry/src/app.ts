// Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
import { logIn } from './accounts/login.js';
import { signUp } from './accounts/signup.js';
import { expiringSoon } from './pantry/expiry.js';
import { addToStock } from './pantry/stock.js';
import { saveRecipe } from './recipes/save.js';
import { searchRecipes } from './recipes/search.js';
import { checkOff } from './shopping/checkOff.js';
import { addItem, listItems } from './shopping/list.js';

/** The app's routes, by area. */
export const routes = {
  'POST /signup': signUp,
  'POST /login': logIn,
  'GET /recipes': searchRecipes,
  'POST /recipes/saved': saveRecipe,
  'GET /shopping': listItems,
  'POST /shopping': addItem,
  'POST /shopping/done': checkOff,
  'POST /pantry': addToStock,
  'GET /pantry/expiring': expiringSoon,
};

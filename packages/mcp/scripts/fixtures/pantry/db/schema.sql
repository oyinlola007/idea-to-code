-- Pantry is a fictitious app, used to test mapping a codebase into a plan. Not real code.
CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE recipes (id SERIAL PRIMARY KEY, title TEXT NOT NULL, ingredients TEXT[] NOT NULL);
CREATE TABLE saved_recipes (user_id INT REFERENCES users(id), recipe_id INT REFERENCES recipes(id));
CREATE TABLE shopping_items (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), name TEXT NOT NULL, done BOOLEAN DEFAULT false);
CREATE TABLE stock (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), name TEXT NOT NULL, expires_on DATE);

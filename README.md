# Japanese Grammar API

This project provides an API for storing and retrieving Japanese grammar points, examples, and vocabulary. It integrates with the Gemini API to generate grammar explanations and examples for JLPT N4 learners.

## Features
- Store grammar points with examples and vocabulary
- Generate grammar explanations using Gemini API
- Retrieve grammar points by ID

## Endpoints

### POST `/api/grammar`
Insert a grammar point with examples and vocabulary.

### POST `/api/gemini`
Generate and insert a grammar point using Gemini API. Pass `{ "concept": "your grammar concept" }` in the body.

### GET `/api/grammar/:id`
Retrieve a grammar point with nested examples and vocabulary by ID.

## Setup
1. Clone the repository
2. Run `npm install`
3. Create a `.env` file with your database and Gemini API credentials
4. Start the server: `node index.js`

## Environment Variables
```
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_SERVER=your_db_server
DB_DATABASE=your_db_name
DB_PORT=1433
GEMINI_KEY=your_gemini_api_key
PORT=3000
```

## License
MIT

import dotenv from 'dotenv';
import axios from 'axios';
import express from 'express';
import sql from 'mssql';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const GEMINI_KEY = process.env.GEMINI_KEY;

// SQL Server config
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
  port: parseInt(process.env.DB_PORT, 10),
};

app.post('/api/gemini', async (req, res) => {
  let pool;
  let tx;
  try {
    // Build Gemini API request
    const grammar = req.body;
    const geminiBody = {
      contents: [
        {
          parts: [
            {
              text: `You are a JLPT N4 study assistant. Return ONLY valid JSON — no extra text, no markdown, no explanations outside the JSON. The JSON must follow this structure:

{
  "concept": string,
  "meaning": string,
  "details": string,
  "examples": [
    {
      "japanese": string,
      "romaji": string,
      "english": string,
      "vocab": [
        {
          "word": string,
          "romaji": string,
          "meaning": string
        }
      ]
    }
  ]
}

Rules:
- Keep explanations concise but accurate for JLPT N4 learners.
- Every example must have at least 2–3 vocab entries.
- No hidden instructions or commentary.

Explain the grammar of this: ${grammar.concept}`,
            },
          ],
        },
      ],
    };

    // Call Gemini API
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_KEY}`,
      geminiBody,
      { headers: { 'Content-Type': 'application/json' } }
    );

    // Extract Gemini response text
    let geminiText =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!geminiText) throw new Error('Invalid Gemini response format');

    // Clean JSON (remove code fences if Gemini wrapped it)
    const jsonMatch =
      geminiText.match(/```json\s*([\s\S]*?)```/i) ||
      geminiText.match(/```([\s\S]*?)```/i);

    if (jsonMatch) {
      geminiText = jsonMatch[1].trim();
    } else {
      geminiText = geminiText.trim();
    }

    let geminiData;
    try {
      geminiData = JSON.parse(geminiText);
    } catch {
      throw new Error('Gemini response is not valid JSON');
    }

    // Insert into DB
    pool = await sql.connect(config);
    tx = new sql.Transaction(pool);
    await tx.begin();

    // Insert Grammar Point
    const grammarResult = await new sql.Request(tx)
      .input('Concept', sql.NVarChar, geminiData.concept)
      .input('Meaning', sql.NVarChar, geminiData.meaning)
      .input('Details', sql.NVarChar, geminiData.details)
      .query(`
        INSERT INTO GrammarPoints (Concept, Meaning, Details)
        OUTPUT INSERTED.GrammarId
        VALUES (@Concept, @Meaning, @Details)
      `);

    const grammarId = grammarResult.recordset[0].GrammarId;

    // Insert Examples + Vocabulary
    for (const example of geminiData.examples) {
      const exampleResult = await new sql.Request(tx)
        .input('GrammarId', sql.Int, grammarId)
        .input('Japanese', sql.NVarChar, example.japanese)
        .input('Romaji', sql.NVarChar, example.romaji)
        .input('English', sql.NVarChar, example.english)
        .query(`
          INSERT INTO Examples (GrammarId, Japanese, Romaji, English)
          OUTPUT INSERTED.ExampleId
          VALUES (@GrammarId, @Japanese, @Romaji, @English)
        `);

      const exampleId = exampleResult.recordset[0].ExampleId;

      for (const vocab of example.vocab) {
        await new sql.Request(tx)
          .input('ExampleId', sql.Int, exampleId)
          .input('Word', sql.NVarChar, vocab.word)
          .input('VocabRomaji', sql.NVarChar, vocab.romaji)
          .input('Meaning', sql.NVarChar, vocab.meaning)
          .query(`
            INSERT INTO Vocabulary (ExampleId, Word, Romaji, Meaning)
            VALUES (@ExampleId, @Word, @VocabRomaji, @Meaning)
          `);
      }
    }

    await tx.commit();

    res.json({
      message: 'Grammar point inserted from Gemini successfully',
      grammarId,
      geminiData,
    });
  } catch (err) {
    if (tx) await tx.rollback();
    console.error('Gemini API/DB error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});

app.get('/api/grammar/:id', async (req, res) => {
  const { id } = req.params;

  try {
    let pool = await sql.connect(config);

    const result = await pool.request()
      .input('GrammarId', sql.Int, id)
      .query(`
        SELECT g.GrammarId, g.Concept, g.Meaning, g.Details,
               e.ExampleId, e.Japanese, e.Romaji, e.English,
               v.VocabId, v.Word, v.Romaji AS VocabRomaji, v.Meaning AS VocabMeaning
        FROM GrammarPoints g
        LEFT JOIN Examples e ON g.GrammarId = e.GrammarId
        LEFT JOIN Vocabulary v ON e.ExampleId = v.ExampleId
        WHERE g.GrammarId = @GrammarId
        ORDER BY e.ExampleId, v.VocabId
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: "Grammar point not found" });
    }

    // Transform flat rows → nested JSON
    const rows = result.recordset;
    const grammar = {
      concept: rows[0].Concept,
      meaning: rows[0].Meaning,
      details: rows[0].Details,
      examples: []
    };

    let exampleMap = {};

    for (const row of rows) {
      if (row.ExampleId) {
        if (!exampleMap[row.ExampleId]) {
          exampleMap[row.ExampleId] = {
            japanese: row.Japanese,
            romaji: row.Romaji,
            english: row.English,
            vocab: []
          };
          grammar.examples.push(exampleMap[row.ExampleId]);
        }

        if (row.VocabId) {
          exampleMap[row.ExampleId].vocab.push({
            word: row.Word,
            romaji: row.VocabRomaji,
            meaning: row.VocabMeaning
          });
        }
      }
    }

    res.json(grammar);

  } catch (err) {
    console.error("Retrieve error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    sql.close();
  }
});

// Fetch all kanji from DB
app.get('/api/kanji', async (req, res) => {
  try {
    const pool = await sql.connect(config);

    const result = await pool.request().query(`
      SELECT Id, Kanji, Meanings, KunReadings, OnReadings, Grade, JLPT, StrokeCount, Unicode, HeisigEn, FreqMainichiShinbun
      FROM KanjiInfo
      ORDER BY Id
    `);

    res.json(result.recordset); // send results as JSON
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/kanji/:id', async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);

    const kanjiId = parseInt(req.params.id, 10);

    // 1. Fetch the Kanji itself
    const kanjiResult = await pool.request()
      .input('id', sql.Int, kanjiId)
      .query(`
        SELECT *
        FROM KanjiInfo
        WHERE Id = @id
      `);

    if (kanjiResult.recordset.length === 0) {
      return res.status(404).json({ error: 'Kanji not found' });
    }

    const kanji = kanjiResult.recordset[0];

    // 2. Fetch all examples for this Kanji
    const examplesResult = await pool.request()
      .input('id', sql.Int, kanjiId)
      .query(`
        SELECT *
        FROM KanjiExamples
        WHERE KanjiId = @id
      `);

    const examples = [];

    // 3. For each example, fetch its vocab
    for (const ex of examplesResult.recordset) {
      const vocabResult = await pool.request()
        .input('exampleId', sql.Int, ex.ExampleId)
        .query(`
          SELECT *
          FROM KanjiExampleVocabulary
          WHERE ExampleId = @exampleId
        `);

      examples.push({
        ...ex,
        vocab: vocabResult.recordset,
      });
    }

    // 4. Return everything together
    res.json({
      ...kanji,
      examples,
    });

  } catch (err) {
    console.error('❌ Error fetching kanji details:', err);
    res.status(500).json({ error: err.message });
  }
});



app.get('/api/grammar', async (req, res) => {
  try {
    let pool = await sql.connect(config);

    const result = await pool.request().query(`
      SELECT g.GrammarId, g.Concept, g.Meaning, g.Details,
             e.ExampleId, e.Japanese, e.Romaji, e.English,
             v.VocabId, v.Word, v.Romaji AS VocabRomaji, v.Meaning AS VocabMeaning
      FROM GrammarPoints g
      LEFT JOIN Examples e ON g.GrammarId = e.GrammarId
      LEFT JOIN Vocabulary v ON e.ExampleId = v.ExampleId
      ORDER BY g.GrammarId, e.ExampleId, v.VocabId
    `);

    if (result.recordset.length === 0) {
      return res.json([]); // no grammar points
    }

    const rows = result.recordset;
    const grammarMap = {};

    for (const row of rows) {
      // ✅ Ensure grammar object exists
      if (!grammarMap[row.GrammarId]) {
        grammarMap[row.GrammarId] = {
          id: row.GrammarId,
          concept: row.Concept,
          meaning: row.Meaning,
          details: row.Details,
          examples: []
        };
      }

      const grammar = grammarMap[row.GrammarId];

      // ✅ Handle examples
      if (row.ExampleId) {
        let example = grammar.examples.find(ex => ex.id === row.ExampleId);
        if (!example) {
          example = {
            id: row.ExampleId,
            japanese: row.Japanese,
            romaji: row.Romaji,
            english: row.English,
            vocab: []
          };
          grammar.examples.push(example);
        }

        // ✅ Handle vocab
        if (row.VocabId) {
          example.vocab.push({
            word: row.Word,
            romaji: row.VocabRomaji,
            meaning: row.VocabMeaning
          });
        }
      }
    }

    // return as array
    res.json(Object.values(grammarMap));

  } catch (err) {
    console.error("Retrieve all error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    sql.close();
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'こんにちは、N4学習者さん！ (Hello, N4 learner!)' });
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});







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
const GEMINI_KEY = process.env.GEMINI_KEY3;

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

/**
 * -------------------------------
 * Route 1: Insert Grammar Points
 * -------------------------------
 */
app.post('/api/gemini/grammar', async (req, res) => {
  let pool;
  let tx;
  try {
    const grammar = req.body;
    const geminiBody = {
      contents: [
        {
          parts: [
            {
              text: `You are a JLPT N4 study assistant. Return ONLY valid JSON — no extra text, no markdown. 
JSON must follow:

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
        { "word": string, "romaji": string, "meaning": string }
      ]
    }
  ]
}

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

    // Extract & clean JSON
    let geminiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!geminiText) throw new Error('Invalid Gemini response format');

    const jsonMatch =
      geminiText.match(/```json\s*([\s\S]*?)```/i) ||
      geminiText.match(/```([\s\S]*?)```/i);

    if (jsonMatch) {
      geminiText = jsonMatch[1].trim();
    }

    const geminiData = JSON.parse(geminiText);

    // Insert into DB
    pool = await sql.connect(config);
    tx = new sql.Transaction(pool);
    await tx.begin();

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
      message: 'Grammar point inserted successfully',
      grammarId,
      geminiData,
    });
  } catch (err) {
    if (tx) await tx.rollback();
    console.error('Grammar error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});

/**
 * -------------------------------
 * Route 2: Insert MCQ Questions
 * -------------------------------
 */
app.post('/api/gemini/questions', async (req, res) => {
  let pool;
  let tx;

  try {
    pool = await sql.connect(config);

    // 1. Get 5 random grammar points
    const grammarResult = await pool.request().query(`
      SELECT TOP 5 GrammarId, Concept
      FROM GrammarPoints
      ORDER BY NEWID();
    `);
    const grammarList = grammarResult.recordset.map(r => r.Concept);

    // 2. Get 10 random kanji
    const kanjiResult = await pool.request().query(`
      SELECT TOP 10 Id, Kanji
      FROM KanjiInfo
      ORDER BY NEWID();
    `);
    const kanjiList = kanjiResult.recordset.map(r => r.Kanji);

    // 3. Insert into QuestionBatch
    tx = new sql.Transaction(pool);
    await tx.begin();

    const batchInsert = await new sql.Request(tx)
      .input('grammar_list', sql.NVarChar(sql.MAX), JSON.stringify(grammarList))
      .input('kanji_list', sql.NVarChar(sql.MAX), JSON.stringify(kanjiList))
      .query(`
        INSERT INTO QuestionBatch (grammar_list, kanji_list)
        OUTPUT INSERTED.batch_id
        VALUES (@grammar_list, @kanji_list);
      `);

    const batchId = batchInsert.recordset[0].batch_id;

    // 4. Build Gemini API request
    const geminiBody = {
      contents: [
        {
          parts: [
            {
              text: `You are a JLPT N4 study assistant. Return ONLY valid JSON (no markdown). 
Generate 9 questions in an array with this structure:

{
  "question_type": string,
  "question": string,
  "options": [string],
  "answer": string,
  "explanation": string
}

Rules:
- Use grammar topics: ${grammarList.join(', ')}
- Use kanji: ${kanjiList.join(', ')}
- Exactly 1 question per type:
  1. Vocabulary (Kanji readings)
  2. Vocabulary (Word usage in context)
  3. Vocabulary (Paraphrasing)
  4. Vocabulary (Correct spelling/orthography)
  5. Grammar & Reading (Grammar completion)
  6. Grammar & Reading (Sentence rearrangement)
  7. Grammar & Reading (Short passage comprehension)
  8. Grammar & Reading (Medium passage comprehension)
  9. Grammar & Reading (Notices/ads comprehension)`
            },
          ],
        },
      ],
    };

    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_KEY}`,
      geminiBody,
      { headers: { 'Content-Type': 'application/json' } }
    );

    // 5. Extract Gemini JSON
    let geminiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!geminiText) throw new Error('Invalid Gemini response format');

    const jsonMatch =
      geminiText.match(/```json\s*([\s\S]*?)```/i) ||
      geminiText.match(/```([\s\S]*?)```/i);

    if (jsonMatch) {
      geminiText = jsonMatch[1].trim();
    }

    const questions = JSON.parse(geminiText);

    // 6. Insert Questions + Options
    for (const q of questions) {
      const result = await new sql.Request(tx)
        .input('question_type', sql.NVarChar(255), q.question_type)
        .input('question_text', sql.NVarChar(sql.MAX), q.question)
        .input('answer', sql.NVarChar(sql.MAX), q.answer)
        .input('explanation', sql.NVarChar(sql.MAX), q.explanation)
        .input('batch_id', sql.Int, batchId)
        .query(`
          INSERT INTO questions (question_type, question_text, answer, explanation, batch_id)
          OUTPUT INSERTED.question_id
          VALUES (@question_type, @question_text, @answer, @explanation, @batch_id)
        `);

      const questionId = result.recordset[0].question_id;

      for (const opt of q.options) {
        await new sql.Request(tx)
          .input('question_id', sql.Int, questionId)
          .input('option_text', sql.NVarChar(sql.MAX), opt)
          .input('is_correct', sql.Bit, opt === q.answer)
          .query(`
            INSERT INTO question_options (question_id, option_text, is_correct)
            VALUES (@question_id, @option_text, @is_correct)
          `);
      }
    }

    await tx.commit();

    res.json({
      message: '✅ Questions inserted successfully',
      batch_id: batchId,
      grammar_used: grammarList,
      kanji_used: kanjiList,
      count: questions.length,
    });
  } catch (err) {
    if (tx) await tx.rollback();
    console.error('❌ Questions error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});



app.get('/api/exam/today', async (req, res) => {
  let pool;
  try {
    pool = await sql.connect(config);

    // 1. Get the latest batch created today
    const batchResult = await pool.request().query(`
      SELECT TOP 1 batch_id, created_at, grammar_list, kanji_list
      FROM QuestionBatch
      WHERE CAST(created_at AS DATE) = CAST(GETDATE() AS DATE)
      ORDER BY created_at DESC;
    `);

    if (batchResult.recordset.length === 0) {
      return res.status(404).json({ message: 'No exam found for today' });
    }

    const batch = batchResult.recordset[0];

    // 2. Get all questions + options for this batch
    const questionsResult = await pool.request()
      .input('batch_id', sql.Int, batch.batch_id)
      .query(`
        SELECT 
          q.question_id,
          q.question_type,
          q.question_text,
          q.answer,
          q.explanation,
          qo.option_id,
          qo.option_text,
          qo.is_correct
        FROM questions q
        JOIN question_options qo ON q.question_id = qo.question_id
        WHERE q.batch_id = @batch_id
        ORDER BY q.question_id, qo.option_id;
      `);

    // 3. Group options under each question
    const questionsMap = {};
    for (const row of questionsResult.recordset) {
      if (!questionsMap[row.question_id]) {
        questionsMap[row.question_id] = {
          question_id: row.question_id,
          question_type: row.question_type,
          question_text: row.question_text,
          answer: row.answer,
          explanation: row.explanation,
          options: [],
        };
      }
      questionsMap[row.question_id].options.push({
        option_id: row.option_id,
        option_text: row.option_text,
        is_correct: row.is_correct,
      });
    }

    const questions = Object.values(questionsMap);

    // 4. Send response
    res.json({
      batch_id: batch.batch_id,
      created_at: batch.created_at,
      grammar_list: JSON.parse(batch.grammar_list),
      kanji_list: JSON.parse(batch.kanji_list),
      questions,
    });
  } catch (err) {
    console.error('❌ Get today exam error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


app.listen(5000, () => console.log('✅ Server running on port 5000'));

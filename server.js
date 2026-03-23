const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Only allow requests from your GitHub Pages site
app.use(cors({
  origin: [
    'https://claudechopper.github.io',
    'http://127.0.0.1:5500', // for local testing
    'http://localhost:5500'
  ]
}));

app.use(express.json({ limit: '20mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Schedule Checker API is running' });
});

// Main analyze endpoint
app.post('/analyze', async (req, res) => {
  const { imageBase64, imageType, startHour, endHour, minStaff } = req.body;

  if (!imageBase64 || !imageType) {
    return res.status(400).json({ error: 'Missing image data' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  const prompt = `You are analyzing an employee work schedule image. Extract every employee's shifts for each day of the week shown.

Return ONLY valid JSON (no markdown, no backticks) in this exact format:
{
  "week_label": "string describing the week if visible",
  "days": ["Monday", "Tuesday", ...],
  "employees": [
    {
      "name": "Employee Name",
      "shifts": {
        "Monday": [{"start": "9:00", "end": "17:00"}],
        "Tuesday": [],
        ...
      }
    }
  ]
}

Rules:
- Use 24-hour time format (e.g., 9:00, 13:30, 17:00, 22:00)
- If an employee has no shift on a day, use an empty array []
- If a shift spans a lunch break but appears as one block, keep it as one shift
- Include ALL employees visible, even if they have no shifts
- Read times as precisely as possible from the visual grid
- Include every day column shown in the image
- Pay close attention to where each colored block starts and ends on the time axis`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: imageType, data: imageBase64 }
            },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Claude API error' });
    }

    const data = await response.json();
    const text = data.content[0].text;

    // Strip any markdown code fences if present
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const schedule = JSON.parse(jsonMatch[1].trim());

    res.json({ schedule });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Schedule Checker API running on port ${PORT}`);
});

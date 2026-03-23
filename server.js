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
        "Monday": [{"start": "13:00", "end": "20:00"}],
        "Tuesday": [],
        ...
      }
    }
  ]
}

CRITICAL - AM/PM conversion to 24-hour time:
- Times on the schedule may show as "1:00p", "8:00p", "9:00a", "12:00p" etc.
- You MUST convert ALL times to 24-hour format before outputting
- AM conversion: 12:00a = "0:00", 1:00a = "1:00", 9:00a = "9:00", 11:30a = "11:30"
- PM conversion: 12:00p = "12:00", 1:00p = "13:00", 2:00p = "14:00", 3:00p = "15:00", 4:00p = "16:00", 5:00p = "17:00", 6:00p = "18:00", 7:00p = "19:00", 8:00p = "20:00", 9:00p = "21:00", 10:00p = "22:00", 11:00p = "23:00"
- Example: a shift showing "1:00p - 8:00p" must be output as start "13:00" end "20:00"
- Example: a shift showing "9:00a - 4:00p" must be output as start "9:00" end "16:00"
- Example: a shift showing "6:00a - 1:00p" must be output as start "6:00" end "13:00"
- NEVER output a PM time as a single digit hour like "1:00" or "8:00" — always convert PM to 13-23 range

Other rules:
- If an employee has no shift on a day, use an empty array []
- Include ALL employees visible, even if they have no shifts
- Read times as precisely as possible from the schedule
- Include every day column shown in the image`;

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

    // Clean up day names — strip trailing date numbers e.g. "Monday 2" → "Monday"
    const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    schedule.days = schedule.days.map(d => {
      const match = dayNames.find(n => d.startsWith(n));
      return match || d;
    });
    schedule.employees = schedule.employees.map(emp => {
      const cleaned = {};
      for (const [day, shifts] of Object.entries(emp.shifts)) {
        const match = dayNames.find(n => day.startsWith(n));
        cleaned[match || day] = shifts;
      }
      return { ...emp, shifts: cleaned };
    });

    // Fix AM/PM time errors mathematically
    // Rule 1: if end < start, end is PM — add 12
    // Rule 2: if shift duration > 12 hours and start < 6, start is PM — add 12
    function parseH(t) {
      const [h, m] = t.split(':').map(Number);
      return h + (m || 0) / 60;
    }
    function fmtT(h) {
      const hrs = Math.floor(h);
      const mins = Math.round((h - hrs) * 60);
      return `${hrs}:${mins.toString().padStart(2, '0')}`;
    }
    schedule.employees = schedule.employees.map(emp => {
      const fixed = {};
      for (const [day, shifts] of Object.entries(emp.shifts)) {
        fixed[day] = shifts.map(s => {
          let start = parseH(s.start);
          let end = parseH(s.end);
          // end before start → end is PM
          if (end < start && end < 12) end += 12;
          // shift > 12 hours with small start → start is PM (e.g. 1AM read instead of 1PM)
          if ((end - start) > 12 && start < 6) start += 12;
          return { start: fmtT(start), end: fmtT(end) };
        });
      }
      return { ...emp, shifts: fixed };
    });

    res.json({ schedule });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Schedule Checker API running on port ${PORT}`);
});

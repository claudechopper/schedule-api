const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://claudechopper.github.io',
    'http://127.0.0.1:5500',
    'http://localhost:5500'
  ]
}));

app.use(express.json({ limit: '20mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'Schedule Checker API is running' });
});

// Parse "9:00" or "13:30" into decimal hours
function parseH(t) {
  const parts = t.split(':').map(Number);
  return parts[0] + (parts[1] || 0) / 60;
}

// Format decimal hours back to "9:00" or "13:30"
function fmtT(h) {
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return hrs + ':' + mins.toString().padStart(2, '0');
}

// Fix AM/PM errors where Claude reads 12-hour times without converting to 24-hour
function fixTimes(start, end) {
  let s = parseH(start);
  let e = parseH(end);

  // Rule 1: end < start and end < 12 means end is PM (e.g. 9 to 4 becomes 9 to 16)
  if (e < s && e < 12) { e += 12; }

  // Rule 2: end is 1-7 and start >= 8 means end is PM (e.g. 9 to 4 becomes 9 to 16)
  if (e >= 1 && e <= 7 && s >= 8) { e += 12; }

  // Rule 3: both are 1-8 means both are PM (e.g. 1 to 8 becomes 13 to 20)
  if (s >= 1 && s <= 8 && e >= 1 && e <= 8 && s <= e) {
    s += 12;
    e += 12;
  }

  // Rule 4: start is 1-7 and end is 8-11 means both are PM (e.g. 3 to 10:45 becomes 15 to 22:45)
  if (s >= 1 && s <= 7 && e >= 8 && e < 12) {
    s += 12;
    e += 12;
  }

  // Rule 5: after fixes if start still > end and end < 12, end is PM
  if (s > e && e < 12) { e += 12; }

  // Rule 6: shift over 12 hours with small start means start is PM (e.g. 1 to 20 becomes 13 to 20)
  if ((e - s) > 12 && s < 6 && s > 0) { s += 12; }

  return { start: fmtT(s), end: fmtT(e) };
}

app.post('/analyze', async (req, res) => {
  const { imageBase64, imageType } = req.body;

  if (!imageBase64 || !imageType) {
    return res.status(400).json({ error: 'Missing image data' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  const prompt = 'You are analyzing an employee work schedule image. Extract every employee shift for each day shown.\n\nReturn ONLY valid JSON with no markdown, no backticks, no explanation:\n{\n  "week_label": "string",\n  "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],\n  "employees": [\n    {\n      "name": "Employee Name",\n      "shifts": {\n        "Monday": [{"start": "13:00", "end": "20:00"}],\n        "Tuesday": []\n      }\n    }\n  ]\n}\n\nRules:\n- Day names must be plain names only: Monday, Tuesday, etc. No dates or numbers attached\n- All times in 24-hour format. Convert AM/PM: 1p=13:00, 2p=14:00, 3p=15:00, 4p=16:00, 5p=17:00, 6p=18:00, 7p=19:00, 8p=20:00, 9p=21:00, 10p=22:00\n- Morning: 9a=9:00, 10a=10:00, 11a=11:00, 12p=12:00\n- Empty array for days with no shift\n- Include ALL employees even those with zero shifts';

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
            { type: 'image', source: { type: 'base64', media_type: imageType, data: imageBase64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(function() { return {}; });
      return res.status(response.status).json({ error: (err.error && err.error.message) || 'Claude API error' });
    }

    const data = await response.json();
    const text = data.content[0].text;

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const schedule = JSON.parse(jsonMatch[1].trim());

    const dayNames = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

    schedule.days = (schedule.days || []).map(function(d) {
      return dayNames.find(function(n) { return d.startsWith(n); }) || d;
    });

    schedule.employees = (schedule.employees || []).map(function(emp) {
      const fixedShifts = {};
      const entries = Object.entries(emp.shifts || {});
      for (let i = 0; i < entries.length; i++) {
        const day = entries[i][0];
        const shifts = entries[i][1];
        const cleanDay = dayNames.find(function(n) { return day.startsWith(n); }) || day;
        fixedShifts[cleanDay] = (shifts || []).map(function(s) {
          return fixTimes(s.start, s.end);
        });
      }
      return Object.assign({}, emp, { shifts: fixedShifts });
    });

    res.json({ schedule: schedule });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, function() {
  console.log('Schedule Checker API running on port ' + PORT);
});

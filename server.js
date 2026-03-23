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
  res.json({ status: 'Schedule Checker API v2 is running' });
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

// Fix AM/PM errors in extracted times
function fixTimes(start, end) {
  let s = parseH(start);
  let e = parseH(end);

  // Rule 1: end < start AND end < 12 → end is PM (e.g. 9:00→4:00 becomes 9:00→16:00)
  if (e < s && e < 12) { e += 12; }

  // Rule 2: duration > 12hrs AND start is 1-8 → start is PM, not AM
  // (e.g. 1:00→20:00 = 19hr impossible → 13:00→20:00 = 7hr normal)
  if ((e - s) > 12 && s >= 1 && s <= 8) { s += 12; }

  // Rule 3: start > end AND both >= 12 AND (start-12) < end → start is 12hrs too large
  // (e.g. 21:00→17:15 means Claude read 9AM as 9PM → subtract 12 → 9:00→17:15)
  // Also catches: 22:00→16:00 → 10:00→16:00, 19:00→13:00 → 7:00→13:00
  if (s > e && s >= 12 && (s - 12) < e) { s -= 12; }

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

  const prompt = `You are analyzing an employee work schedule image. Extract every employee shift for each day shown.

Return ONLY valid JSON with no markdown, no backticks, no explanation:
{
  "week_label": "string",
  "days": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  "employees": [
    {
      "name": "Employee Name",
      "shifts": {
        "Monday": [{"start": "9:00", "end": "17:00"}],
        "Tuesday": []
      }
    }
  ]
}

Rules:
- Day names must be plain names only: Monday, Tuesday etc. No dates or numbers
- Times must be in 24-hour format
- Each shift block on the schedule shows a start and end time with "a" (AM) or "p" (PM)
- AM times output as-is: 6a=6:00, 7a=7:00, 8a=8:00, 9a=9:00, 10a=10:00, 11a=11:00
- 12p = 12:00. For all other PM times ADD 12: 1p=13:00, 2p=14:00, 3p=15:00, 4p=16:00, 5p=17:00, 6p=18:00, 7p=19:00, 8p=20:00
- A shift showing "9a-4p" outputs as start "9:00" end "16:00"
- A shift showing "6a-1p" outputs as start "6:00" end "13:00"
- A shift showing "1p-8p" outputs as start "13:00" end "20:00"
- Empty array for days with no shift
- Include ALL employees even those with zero shifts`;

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

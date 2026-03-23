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

CRITICAL - READ THE TIME AXIS REFERENCE:
- The schedule displays a time axis (usually on left side) with hour labels: 9am, 10am, 11am, 12pm, 1pm, 2pm, 3pm, 4pm, 5pm, 6pm, 7pm, 8pm, etc.
- Each employee's colored shift block is positioned relative to these axis labels
- Use the axis labels as your ground truth to read exact times
- If a shift block sits between the "1pm" and "8pm" labels, output it as start "13:00" end "20:00" (NOT "1:00" or "8:00")
- If a shift block sits between "6am" and "1pm" labels, output it as start "6:00" end "13:00"
- Convert all times to proper 24-hour format based on their visual position on the axis
- Times 0:00-11:59 are morning, times 12:00-23:59 are noon/evening
- Never output ambiguous single-digit PM times like "1:00", "2:00", "3:00" etc. in the 9am-7pm business window — if you see "1" in the afternoon section, it's "13:00"

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

          // Rule 1: if end < start, end is definitely PM — add 12
          if (end < start && end < 12) end += 12;

          // Rule 2: if end is 1-7 and start >= 8, end is PM — add 12
          // (e.g., 9:00 → 4:00 means 4PM not 4AM)
          if (end >= 1 && end <= 7 && start >= 8) end += 12;

          // Rule 3: if start is 1-7 and end >= 12, start is PM — add 12
          // (e.g., 1:00 → 20:00 means 1PM start, not 1AM)
          if (start >= 1 && start <= 7 && end >= 12) start += 12;

          // Rule 4: shift > 12 hours with small start → start is PM
          if ((end - start) > 12 && start < 6 && start > 0) start += 12;

          // Rule 5: if both start and end are 1-8 (low numbers), they're probably both PM
          // (e.g., 1:00 → 8:00 in a 9-7 business = 1PM to 8PM)
          if (start >= 1 && start <= 8 && end >= 1 && end <= 8 && start <= end) {
            start += 12;
            end += 12;
          }

          // Rule 6: if start is 1-7 but end is > 8, start is PM (e.g., 3:00 → 10:45 = 3PM → 10:45PM)
          if (start >= 1 && start <= 7 && end > 8) {
            start += 12;
          }

          // Rule 7: if after adjustments start > end, end must be PM too — add 12
          if (start > end && end < 12) {
            end += 12;
          }

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

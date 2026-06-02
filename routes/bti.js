const express = require('express');
const OpenAI = require('openai');

const router = express.Router();

/* GET /api/bti/questions — GPT가 질문 4개 생성 */
router.get('/questions', async (req, res) => {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content: `당신은 빵 취향 테스트(빵BTI)를 만드는 기획자입니다.
사용자의 빵 취향을 알아볼 수 있는 재미있고 창의적인 질문 4개를 만들어주세요.
각 질문은 2개의 선택지를 가지며, 선택지는 서로 다른 빵 취향을 나타냅니다.
반드시 아래 형식의 JSON 배열만 반환하고 다른 텍스트는 포함하지 마세요:
[
  {
    "question": "질문 내용 (Q. 형식으로)",
    "options": [
      { "emoji": "🥐", "name": "빵 이름", "desc": "한 줄 설명" },
      { "emoji": "🍩", "name": "빵 이름", "desc": "한 줄 설명" }
    ]
  }
]`
        },
        {
          role: 'user',
          content: '빵BTI 질문 4개를 만들어주세요. 매번 다양하고 재미있는 상황으로 구성해주세요.'
        }
      ],
      temperature: 1.1,
      max_tokens: 1000,
    });

    const raw = completion.choices[0].message.content.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const questions = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    res.json(questions);
  } catch (err) {
    console.error('BTI 질문 생성 에러:', err.message);
    res.status(500).json({ message: '질문 생성 실패: ' + err.message });
  }
});

/* POST /api/bti/result — 답변 분석 후 빵 유형 반환 */
router.post('/result', async (req, res) => {
  try {
    const { answers } = req.body; // [{ question, chosen: { name, desc } }]
    if (!answers || answers.length === 0) {
      return res.status(400).json({ message: '답변이 없습니다.' });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const answerText = answers.map((a, i) =>
      `Q${i + 1}. ${a.question}\n→ 선택: ${a.chosen.name} (${a.chosen.desc})`
    ).join('\n\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content: `당신은 빵 취향 분석 전문가입니다.
사용자의 빵BTI 답변을 분석해 고유한 빵 유형을 만들어주세요.
유형 이름은 재미있고 개성 있게 (예: "바삭장인", "크림폭탄", "새벽빵러버" 등),
설명은 2-3문장으로 공감되게 작성해주세요.
추천 메뉴 키워드는 실제 빵 이름으로 2-3개.
색상은 유형 분위기에 맞는 hex 코드.
반드시 아래 형식의 JSON만 반환하세요:
{
  "typeName": "유형 이름",
  "emoji": "대표 이모지 1개",
  "description": "유형 설명 2-3문장",
  "keywords": ["추천 메뉴1", "추천 메뉴2"],
  "color": "#hex색상코드"
}`
        },
        {
          role: 'user',
          content: `다음은 사용자의 빵BTI 답변입니다:\n\n${answerText}\n\n이 사람의 빵 유형을 분석해주세요.`
        }
      ],
      temperature: 1.0,
      max_tokens: 500,
    });

    const raw = completion.choices[0].message.content.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    res.json(result);
  } catch (err) {
    console.error('BTI 결과 분석 에러:', err.message);
    res.status(500).json({ message: '결과 분석 실패: ' + err.message });
  }
});

module.exports = router;

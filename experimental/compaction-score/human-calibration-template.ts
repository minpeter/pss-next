export const HUMAN_CALIBRATION_QUESTION_ORDER_SEED =
  "human-calib-v2-question-order";

export const HUMAN_CALIBRATION_LABEL_HEADER =
  "packet_id,content_digest,qid,annotator_id,annotator_role,session_id,labeled_at_utc,viewed_arm,human_answer,candidate_match,confidence,difficulty,notes,seconds_spent,protocol_version";

export const HUMAN_CALIBRATION_INSTRUCTIONS = `# Human calibration annotation

Use only \`packets.blinded.jsonl\`, \`labels-template.csv\`, and this file while labeling. The coordinator must keep \`packets.keys.jsonl\` and \`arm-mapping.hmac.jsonl\` sealed until all labels are final.

For every prefilled CSV row:

1. Find the matching \`packet_id\` and \`qid\` in the blinded packet.
2. Read the conversation and question in the packet's randomized presentation order.
3. Inspect only the candidate named by \`viewed_arm\`; do not compare A and B while judging a row.
4. Enter your own answer in \`human_answer\`.
5. Set \`candidate_match\` by comparing the viewed candidate with your own answer: \`exact\`, \`equiv\`, \`wrong\`, or \`unknown\`.
6. Fill a stable human \`annotator_id\`, role, session, UTC timestamp, confidence 1-5, difficulty, notes, and seconds spent.

Do not use an LLM, automated grader, search tool, or the sealed key file. Preserve every prefilled identity and protocol field. Save the completed CSV separately from the packet directory.

## 한국어 안내

이 평가는 반드시 실제 사람이 직접 수행해야 합니다. \`packets.blinded.jsonl\`에서 해당 \`packet_id\`와 \`qid\`를 찾고, CSV 행의 \`viewed_arm\`에 지정된 후보 하나만 읽으세요. 같은 질문의 A와 B를 서로 비교하지 마세요.

본인이 판단한 정답을 \`human_answer\`에 적고, 후보와의 관계를 \`candidate_match\`에 \`exact\`, \`equiv\`, \`wrong\`, \`unknown\` 중 하나로 기록하세요. \`confidence\`는 1-5, \`seconds_spent\`는 실제 소요 시간을 양의 초 단위로 입력합니다. 사람을 식별할 수 있는 안정적인 \`annotator_id\`는 \`human:<id>\` 형식을 사용하고, 역할·세션·UTC 시각·난이도·메모도 채우세요.

LLM, 자동 채점기, 검색 도구, sealed key 파일을 사용하면 안 됩니다. 미리 채워진 ID, digest, arm, protocol 값은 수정하지 말고, 완성한 CSV는 packet 디렉터리 밖에 저장하세요.
`;

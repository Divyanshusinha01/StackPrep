# GitHub Repository 1-on-1 AI Interview — PRD

## 1. Product Overview

A voice-first technical interview platform where a user connects GitHub, selects one repository, and gets interviewed by an AI agent about that repository.

The interview is designed to evaluate:

- Understanding of the codebase
- Engineering and problem-solving ability
- Ability to explain and defend technical decisions
- Ownership-level understanding of code, including AI-assisted code

The experience should feel like a natural human-to-human technical interview, while the AI uses the repository as evidence and adapts its questions throughout the session.

---

## 2. Core Product Flow

```text
GitHub OAuth
    ↓
User selects repository
    ↓
Repository Workspace created/opened
    ↓
Lightweight repository analysis starts
    ↓
Background deeper analysis
    ↓
Workspace becomes interview-ready once baseline context is usable
    ↓
User starts Interview
    ↓
Camera + microphone check
    ↓
Brief AI introduction
    ↓
30-minute adaptive voice interview
    ↓
Final report generated immediately
    ↓
Report saved inside repository workspace
    ↓
User can start another interview
```

Each repository has its own permanent workspace.

Example:

```text
Workspace: owner/repository

├── Repository
├── Interview 1
│   └── Report
├── Interview 2
│   └── Report
├── Interview 3
│   └── Report
└── ...
```

---

## 3. Authentication and Repository Access

### GitHub

- User signs up/connects through GitHub OAuth.
- User selects one repository for a workspace.
- Public repositories are supported.
- Private repositories are supported only when the user explicitly grants the required access for that workspace.
- Git history is not part of interview context.

### Repository handling

The application does **not** clone/download the repository into persistent infrastructure.

Repository contents are accessed through the GitHub API.

The system should:

- Fetch repository tree/structure.
- Fetch relevant files when required.
- Dynamically inspect additional files during the interview.
- Avoid persistent copies of repository source code where possible.
- Respect GitHub permissions and workspace isolation.

---

## 4. Repository Analysis

Repository analysis is hybrid.

### Immediately after repository selection

Start lightweight analysis.

User sees:

```text
Scanning files
→ Understanding architecture
→ Preparing interview context
```

### Background analysis

Deeper analysis continues in the background.

The user does not need to wait for the entire repository analysis.

Once baseline context is usable, the user can start the interview.

During the interview, the AI can dynamically fetch additional repository files through the GitHub API.

### Analysis scope

Analyze everything relevant while automatically excluding:

- Generated files
- Build artifacts
- Dependencies such as `node_modules`
- Large/irrelevant files
- Binary files
- Secrets/credentials
- Unsafe or inappropriate content for analysis

The analysis should identify:

- Repository structure
- Major modules
- Architecture
- Technologies
- Configuration
- Tests
- Documentation
- Important implementation areas
- Security-sensitive areas
- Major technical decisions
- Repository-specific concepts

---

## 5. Repository Coverage Map

Before/during the interview, the AI maintains an internal coverage map.

The coverage map identifies:

- Major architectural areas
- Important modules
- Important files
- Technical decision areas
- Security areas
- Testing areas
- Infrastructure/deployment areas
- Repository-specific areas

The goal is not to ask about every file.

The goal is to ensure that the **important parts of the entire repository are meaningfully covered**.

The AI may inspect individual files when deeper evidence is needed.

The coverage strategy is hidden from the user.

---

## 6. Interview Planning

The AI creates a high-level interview plan and coverage map before/during the interview.

However, the actual questions are generated dynamically.

```text
Repository
    ↓
Coverage Map
    ↓
High-Level Interview Plan
    ↓
Question 1
    ↓
User Answer
    ↓
Evaluate + inspect repository
    ↓
Question 2
    ↓
...
```

The AI should not pre-generate a rigid list of questions.

The interview must adapt to:

- User's answers
- Demonstrated technical understanding
- Repository complexity
- Areas already covered
- Previous weaknesses
- Need for deeper probing
- Remaining repository coverage

---

## 7. Interview Duration

Target duration: **approximately 30 minutes**.

The interview is adaptive.

The AI may:

- Finish earlier if sufficient evidence has been gathered.
- Continue questioning when necessary around the 30-minute target.
- Balance depth against repository coverage.

Hard limits:

- At **30 minutes** of voice time, the AI starts wrapping up: no new topics, finish the current question, give a closing statement.
- At **35 minutes** of voice time, the interview ends regardless. The AI gives a short closing statement if it can.
- Voice time counts only while the voice session is connected, so technical interruptions do not use it up.
- If the user says nothing for **3 minutes**, the voice session closes. This is treated like a technical interruption: the user can reconnect and resume from the persisted state, within the 35-minute limit.

The user sees only **elapsed time**.

The user does not see:

- Coverage progress
- Remaining topics
- Internal scoring
- Interview strategy

This keeps the questioning unpredictable.

---

## 8. Difficulty

There is no user-selected difficulty level.

Difficulty is determined automatically from:

- Repository complexity
- Technical depth of the repository
- User's demonstrated understanding
- Quality of previous answers during the current interview

The AI adapts technical depth dynamically.

---

## 9. Interview Categories

The evaluation has a core set of categories:

- Architecture
- Code understanding
- Backend
- Frontend
- Database
- Security
- Testing
- Infrastructure/deployment
- Problem-solving
- Technical decision-making

The AI may add repository-specific categories when required.

Evaluation categories are hidden from the user during the interview.

---

## 10. Question Behavior

Questions are asked one at a time.

The AI should:

- Ask concise technical questions.
- Follow up when the answer requires deeper investigation.
- Skip areas when sufficient evidence has already been gathered.
- Increase or decrease technical depth based on demonstrated understanding.
- Ask about technical decisions even when the rationale is not explicitly documented.
- Test whether the user actually understands code they own, including AI-generated code.
- Probe complex or critical implementation areas more deeply.

Example:

> "Why did you choose this authentication approach?"

The AI can then inspect relevant repository files and ask a deeper follow-up based on the answer.

---

## 11. Repository Evidence in the UI

The user should see evidence that the question is grounded in the repository.

When relevant, show:

```text
Examining src/auth/...
```

Then display the relevant:

- File
- Module
- Repository area

Do not expose internal reasoning.

The exact code/context does not need to be shown; the file/module acts as scope evidence.

---

## 12. Voice Interview

The interview is voice-first.

The interaction should feel like a real human technical interview.

### Question flow

```text
AI question appears as text
        ↓
AI speaks the question
        ↓
User answers by voice
        ↓
User transcript appears
        ↓
AI evaluates answer
        ↓
AI asks follow-up / next question
```

### Voice behavior

Support:

- Natural turn-taking
- Interruptions / barge-in
- Clarifications
- Follow-up questions
- Conversational discussion
- Repository-related tangents
- Returning naturally to the interview

If the user interrupts the AI:

1. AI stops speaking.
2. Determines whether the user is clarifying, asking a question, or answering.
3. Responds appropriately.
4. Continues the interview naturally.

The AI should behave like a human interviewer rather than a rigid questionnaire.

---

## 13. Live Transcription

The interview UI has two transcript streams.

### AI window

Shows what the AI interviewer says.

### User window

Shows the user's live speech transcription.

AI internal evaluation/reasoning is never shown.

The AI question appears as text **before** it is spoken so the user can see the question.

---

## 14. User Interaction

The user can ask the interviewer questions.

The AI may:

- Answer clarification questions.
- Discuss repository-related topics.
- Engage in natural conversation.
- Follow relevant tangents.
- Return to the interview flow.

The interview should preserve the overall ~30-minute constraint.

---

## 15. User Identity

The authenticated GitHub user is assumed to be the person who built/maintains the selected repository.

The interview therefore tests ownership-level understanding.

Example:

> "You implemented this authentication flow. Why is the refresh token handled this way?"

The AI does not require the user to explicitly establish authorship before interviewing.

---

## 16. AI-Assisted Code

The system assumes code may have been written with AI coding tools.

AI-assisted code is evaluated exactly like other code.

The interviewer should test whether the user understands:

- What the code does
- Why it exists
- Why it was designed that way
- Important tradeoffs
- Failure modes
- Security implications
- How critical components work internally

Complex and critical AI-assisted code should receive deeper "why/how" questioning.

---

## 17. Contradictions and Repository Evidence

If the user's answer conflicts with repository evidence:

The AI should **not immediately reveal the discrepancy**.

Instead:

1. Ask a neutral follow-up.
2. Continue probing naturally.
3. Record the discrepancy internally.
4. Include the actual evidence in the final report.

Example:

User claims an API validates every request.

Repository evidence shows an endpoint without that validation.

The AI should ask a neutral question about the validation architecture rather than saying the user is wrong.

---

## 18. Security and Secrets

The system must never expose:

- API keys
- Passwords
- Tokens
- Credentials
- Environment secrets
- Other sensitive secret values

The AI must not ask the user to reveal secret values.

However, it should still evaluate:

- Secret management
- Authentication
- Authorization
- Data protection
- Security architecture
- Security tradeoffs

---

## 19. Camera and Microphone

Camera and microphone are mandatory.

Before entering an interview:

1. Camera check
2. Microphone check
3. Both must pass
4. Enter interview

The pre-interview UI should remain minimal and simply communicate that camera and microphone are required.

The interview uses video for behavioural/integrity monitoring.

---

## 20. Integrity Monitoring

Computer vision may analyze observable user behaviour for potential external assistance or unusual behaviour.

These observations are **signals**, not automatic proof of misconduct.

Monitoring analyzes one low-detail camera frame about every 10 seconds. Frames are analyzed and discarded. Only the detected signals and warnings are stored, never the images.

### Warning policy

- First detected signal → warning
- Second detected signal → warning
- Third detected signal → terminate interview

Warning example:

> "We detected that you may be looking away from the screen. Please remain focused."

The warning is shown immediately.

If the third warning occurs:

- Interview terminates.
- Termination is recorded in interview history.
- User may start another interview immediately.
- The next interview is a fresh evaluation.

---

## 21. Pausing and Technical Interruptions

### Voluntary pause

The user can stop the interview with a **Stop interview** button and continue it later.

- Stopping requires an explicit confirmation in the UI. Spoken intent never pauses the interview.
- At most **3 pauses** per interview. After the third, the button is no longer offered.
- A paused interview must be resumed within **1 hour**. After that it ends as abandoned, with no report, and the next interview is a fresh evaluation.
- Voice time stops while paused, so pausing does not use up the 35-minute limit.
- The user can resume from the interview page or from a **Resume** link in interview history. Resuming goes through the camera and microphone check again, then the interviewer picks up from the last answer.
- Integrity monitoring is suspended while paused and starts again once the voice session reconnects.

### Technical interruptions

Technical interruptions such as these pause the interview automatically:

- Camera failure
- Microphone failure
- Network interruption
- Similar technical problems

When the user reconnects:

1. Re-evaluate the current question/context.
2. Confirm that no answer was lost.
3. Resume from the correct interview state.

---

## 22. Audio Retention

The system does not retain interview audio.

Audio may exist temporarily for real-time speech processing/transcription and is then discarded.

Persist:

- Transcript
- Interview state
- Evaluation data
- Report
- Relevant evidence references

Do not persist the full audio recording.

---

## 23. Interview Memory

Repository memory and interview memory are separate concepts.

### Repository memory

Persistent across interviews.

Used to avoid repeatedly performing the same baseline repository analysis.

Can contain:

- Architecture summary
- Technologies
- Important modules
- Important files
- Repository-specific concepts
- Previous repository understanding

### Interview memory

Each interview is a fresh evaluation.

Previous answers do **not** count as evidence of current ability.

However, the system remembers previous interview:

- Coverage
- Outcomes
- Strengths
- Weaknesses
- Areas tested

This allows later interviews to become progressively deeper.

---

## 24. Multiple Interviews

A repository has one permanent workspace.

The user can run:

```text
Interview 1
Interview 2
Interview 3
...
```

at any time.

There is no mandatory waiting period between interviews.

To prevent abuse, a user can start at most **5 interviews per rolling 24 hours** across all workspaces. Every started interview counts, including abandoned and integrity-terminated ones. There is no monthly quota. When the limit is reached, the user sees when they can start the next interview.

Interview 2 should feel fresh while using previous interview outcomes to improve question selection.

### Later interview behavior

The AI should:

- Prioritize previous weaknesses.
- Retest previously strong areas at greater depth.
- Continue repository coverage.
- Avoid unnecessary repetition.
- Never treat previous answers as current evidence.

The user can review Interview 1's report, prepare, and then attempt Interview 2.

---

## 25. Workspace

One workspace corresponds to one repository.

The workspace UI should remain minimal.

Show:

- Repository
- Interview history
- Interview reports
- Start Interview

Do not expose the internal AI coverage map.

---

## 26. Interview Reports

The final report is generated **immediately after the interview**.

No separate deep post-interview repository analysis is required.

The report uses:

- Current interview evidence
- Existing repository analysis
- Repository evidence gathered during the interview
- Previous interview context where relevant

### Report structure

The report contains:

1. Executive summary
2. Category-wise evaluation
3. Strengths
4. Weaknesses / knowledge gaps
5. Evidence from the interview
6. Evidence from the repository
7. Areas to improve
8. Full interview transcript

There is **no overall score**.

Do not rank the user.

---

## 27. Report Question Analysis

For questions where the user struggled, the report should show:

- Question asked
- User's performance
- Identified weakness
- Relevant repository area
- Learning direction

The report should **not reveal the exact expected/correct answer**.

The purpose is to allow the user to prepare for the next interview without giving away the solution.

---

## 28. Interview History

Each interview remains inside its repository workspace.

History should preserve:

- Interview number
- Status
- Report
- Transcript
- Date/time
- Integrity termination status if applicable

A terminated interview remains in history.

---

## 29. Interview Completion

The AI may finish:

- Earlier than 30 minutes when sufficient evidence is gathered, or
- Around the 30-minute target, and never later than the 35-minute hard limit (see [Interview Duration](#7-interview-duration)).

The AI gives a clear closing statement before ending.

The final report is then generated immediately.

---

## 30. Initial Product Principle

The core experience should feel like:

```text
GitHub Repository
       ↓
AI understands the repository
       ↓
Human-like technical interview
       ↓
Question
       ↓
Answer
       ↓
AI understands answer
       ↓
AI checks repository evidence
       ↓
Adaptive follow-up
       ↓
Continue until sufficient evidence / ~30 min
       ↓
Report
       ↓
User prepares
       ↓
Interview again
       ↓
Deeper evaluation
```

The product is not a fixed question bank.

It is an **adaptive AI technical interviewer grounded in the user's actual GitHub repository**.

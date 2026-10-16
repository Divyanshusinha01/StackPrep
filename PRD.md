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
User adds and validates their OpenAI API key (Settings)
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

### OpenAI API key (bring your own key)

Every AI feature runs on the user's own OpenAI API key. StackPrep has no platform key and never pays for, marks up, or falls back to another key for a user's AI usage; OpenAI bills the user directly.

- **One key per account.** The key belongs to the signed-in user and serves all of their workspaces. Only that user can view its status, replace it, or delete it.
- **Setup.** The user adds the key on the Settings page. A user without a working key who tries an AI action is sent to Settings and returned to where they were after saving.
- **First run.** Right after GitHub sign-in, a user with no workspaces and no working key is taken to Settings in a guided setup step (sign in, add key, connect repository) before they can connect the GitHub App or pick a repository. Saving a valid key continues straight to the repository step. Users who already have workspaces can still browse them, their history, and finished reports without a key; the account menu flags a missing or broken key on every app page.
- **Landing page.** The landing page states the model upfront: the user brings their own OpenAI key and pays OpenAI directly, and StackPrep runs the interview infrastructure, realtime voice, GitHub integration, evaluation, and reports. It shows the setup order (sign in, add key, connect repository), never implies free AI usage, and quotes no prices.
- **Validation before storage.** The key must look like an OpenAI secret key (`sk-...`; admin keys are rejected) and pass one small embedding request on the user's account. If validation fails, nothing is stored and any key already saved stays active. Checks are rate limited per user.
- **What the user sees.** Only the last four characters (`sk-...abcd`), the status (Working, Rejected by OpenAI, Out of quota, Missing model access), and when it was last validated. The full key is never shown again, never pre-filled, and never sent to the browser.
- **Required for:** creating a workspace, retrying analysis, push-sync re-indexing, interview planning, starting or resuming a voice session, answer evaluation, integrity frame checks, repository search embeddings, deep analysis, and reports. Reopening an existing workspace, reading history, and viewing finished reports do not need a key.
- **When OpenAI rejects the key** (revoked, out of quota, missing model access), the stored status is updated, the current action fails with a specific message and a link to Settings, and background jobs fail without retrying. Failed reports and planning can be retried once the key is fixed. An ordinary OpenAI rate limit is retried and does not change the status.
- **Replace and delete.** Replacing a key keeps the old one until the new one validates. Deleting it stops AI features from the next request; a voice session that is already connected continues until OpenAI ends it.
- **Spend.** Usage is recorded per interview and attributed to the key that was used, so the user can relate it to their OpenAI bill. The 5-interviews-per-24-hours limit stays as a fair-use guard, not a cost control.

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

The user's own OpenAI API key is stored encrypted, used only server-side, and never returned to the browser, written to logs, or sent to error monitoring (see "OpenAI API key" in section 3).

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

### Ending the interview

The user can end the interview early with an **End interview** button, next to **Stop interview** in the live room and on the paused screen.

- Ending requires an explicit confirmation in the UI ("Your report will be generated from the answers so far. This can't be undone."). Spoken intent never ends the interview.
- It cannot be undone; the interview cannot be resumed afterwards.
- If at least one answer has been evaluated, the interview is completed and the report is generated from the answers so far, the same way as when the AI finishes.
- If no answer has been evaluated yet, there is nothing to report on: the interview ends as abandoned, with no report.
- Ending does not count as a pause and does not use one up.

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
2. Performance breakdown (category-wise evaluation, strengths, weaknesses / knowledge gaps)
3. Question-by-question review
4. Concepts to learn, with cited learning resources
5. Improved answer examples
6. Prioritized learning plan
7. Final recommendations
8. Evidence from the interview and from the repository
9. Full interview transcript

Sections adapt to the data available: a section with nothing grounded to say shows an empty state instead of invented content.

There is **no overall score**.

Do not rank the user.

Reports generated before the learning report keep their original structure (executive summary, categories, strengths, gaps, evidence, areas to improve, questions to revisit) and remain readable. Such a report offers **Regenerate report**: after a confirmation that it uses the user's OpenAI key, the report is rebuilt from the saved transcript as a learning report. The old report stays visible until the new one is saved; a failed regeneration leaves it unchanged and can be tried again.

---

## 27. Report Question Analysis

The report is a learning tool: it explains what went wrong, shows what a strong answer looks like, and how to improve.

For every evaluated question, the report shows:

- **Question:** the question as asked, from the transcript.
- **Your answer:** the candidate's own words, from the transcript (marked unanswered when there were none).
- **Assessment:** correct, partially correct, incorrect, or unanswered. Derived from the evaluation recorded during the interview, so it is consistent with the category ratings.
- **What was missing or wrong:** factual errors, missing concepts, and communication weaknesses, kept separate.
- **Expected answer:** an AI-generated reference answer appropriate to the question and the repository.
- **Ideal answer:** an example of how a strong candidate could answer, with code where it helps.
- **Valid alternatives:** other technically sound approaches; the reference is never the only acceptable answer.
- **How to improve:** concrete, ordered steps.

Content from the transcript, judgments from the evaluator, and AI-generated reference material are labeled as such. Candidate answers and questions are never paraphrased into something they did not say.

### Concepts to learn

For each significant knowledge gap the report names the underlying concept, explains it briefly, says why it matters in practice, and links learning resources found by web search on the user's own OpenAI key. Each resource shows its title, publisher, link, and what to learn from it, and is tied to the gap it addresses. Official documentation is preferred. Links come only from the search results; when none can be retrieved, the report says resources are unavailable instead of inventing them. Search queries contain only generic concept names, never repository names, file paths, transcript text, or secrets.

### Learning plan

A prioritized list of practical exercises, each tied to a concept, with a way to check success and an effort estimate, followed by the few next steps most likely to improve the next interview.

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

The user can delete any interview from history, in any status, after a confirmation. An interview that is pending, in progress or paused is first ended without a report (terminated as abandoned, closing any open voice session), and the confirmation says so. A deleted interview:

- disappears from the workspace and global history, and its report and transcript are no longer accessible to the user
- still counts toward the 5-interviews-per-24-hours limit
- keeps its interview number, which is never reused
- can still inform planning of later interviews in the same workspace, so previous coverage is remembered

---

## 29. Interview Completion

The AI may finish:

- Earlier than 30 minutes when sufficient evidence is gathered, or
- Around the 30-minute target, and never later than the 35-minute hard limit (see [Interview Duration](#7-interview-duration)).

The AI gives a clear closing statement before ending.

The final report is then generated immediately.

The user can also end the interview early with **End interview** (see [Ending the interview](#ending-the-interview)). The report is then generated from the answers so far, or not at all if no answer was evaluated.

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

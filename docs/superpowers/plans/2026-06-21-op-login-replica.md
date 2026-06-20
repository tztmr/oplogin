# OP Login Replica Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recreate the public OP login flow locally by generating the app wake-up URL from OP token data.

**Architecture:** Add a focused encoder module that builds the Tencent URL scheme and binary plist pasteboard payload locally. Update the Express API to use local generation first and fall back to the original remote API only when local parsing fails. Keep the existing static frontend but align the dropdown options with the captured source page.

**Tech Stack:** Node.js CommonJS, Express, built-in `node:test`, custom binary plist writer.

---

### Task 1: Local URL encoder

**Files:**
- Create: `lib/op-url.js`
- Test: `test/op-url.test.js`

- [ ] Write tests for OP token parsing and generated URL structure.
- [ ] Verify tests fail before implementation.
- [ ] Implement local Tencent URL scheme and binary plist generation.
- [ ] Verify tests pass.

### Task 2: API integration

**Files:**
- Modify: `server.js`
- Modify: `package.json`

- [ ] Add `npm test` script.
- [ ] Update `/api/submit` to call local encoder first.
- [ ] Keep remote `https://www.opdengluqi.com/api.php` as fallback.
- [ ] Verify API with a sample POST.

### Task 3: Frontend options

**Files:**
- Modify: `public/index.html`

- [ ] Replace the app dropdown with the captured option list.
- [ ] Keep Douyin as selected default.
- [ ] Verify the form still posts `url` and `game`.

# OP Login Android Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline-first Android APK that embeds the `/oplogin` page locally and generates wake links on-device.

**Architecture:** Add a standalone Android app module under `android-app/` that loads a bundled HTML asset in a `WebView`, bridges the submit action into native Java code, and opens the generated wake URL through Android intents.

**Tech Stack:** Android Gradle Plugin, Java 17, WebView, local HTML/CSS/JS assets

## Global Constraints

- Keep the package name editable in a few explicit files so the user can rename it later.
- Prefer local wake-url generation over network requests.
- Output the built APK into a workspace `apks/` folder.

---

### Task 1: Scaffold Android project

**Files:**
- Create: `android-app/settings.gradle`
- Create: `android-app/build.gradle`
- Create: `android-app/gradle.properties`
- Create: `android-app/local.properties`
- Create: `android-app/app/build.gradle`
- Create: `android-app/app/proguard-rules.pro`

**Interfaces:**
- Consumes: existing workspace root and local Android SDK
- Produces: a buildable Android app module named `:app`

- [ ] **Step 1: Write the project and module Gradle files**
- [ ] **Step 2: Point the project at the local Android SDK**
- [ ] **Step 3: Keep `namespace` and `applicationId` grouped in one place for easy package rename**

### Task 2: Add the Android shell and local wake-url builder

**Files:**
- Create: `android-app/app/src/main/AndroidManifest.xml`
- Create: `android-app/app/src/main/java/com/dongpeng/oplogin/MainActivity.java`
- Create: `android-app/app/src/main/java/com/dongpeng/oplogin/OpLoginBridge.java`
- Create: `android-app/app/src/main/java/com/dongpeng/oplogin/OpWakeUrlBuilder.java`
- Create: `android-app/app/src/main/res/layout/activity_main.xml`
- Create: `android-app/app/src/main/res/values/strings.xml`
- Create: `android-app/app/src/main/res/values/colors.xml`
- Create: `android-app/app/src/main/res/values/themes.xml`
- Create: `android-app/app/src/main/res/xml/backup_rules.xml`
- Create: `android-app/app/src/main/res/xml/data_extraction_rules.xml`
- Create: `android-app/app/src/main/res/drawable/ic_launcher_foreground.xml`
- Create: `android-app/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`
- Create: `android-app/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml`

**Interfaces:**
- Consumes: local HTML asset submit events
- Produces: JavaScript bridge methods `buildWakeUrl(opValue, gameId)` and `openWakeUrl(wakeUrl)`

- [ ] **Step 1: Add a `WebView` host activity**
- [ ] **Step 2: Port the wake-url generation logic from `lib/op-url.js` into Java**
- [ ] **Step 3: Expose the local generator to JavaScript and launch wake intents**

### Task 3: Bundle the `/oplogin` page and document package renaming

**Files:**
- Create: `android-app/app/src/main/assets/oplogin.html`
- Create: `android-app/README.md`

**Interfaces:**
- Consumes: `/oplogin` page structure and game list from the existing web app
- Produces: a bundled offline page and clear package rename instructions

- [ ] **Step 1: Copy the current page into a bundled asset and switch submit handling to the native bridge**
- [ ] **Step 2: Add README notes for package-name edits and APK output path**
- [ ] **Step 3: Build and copy the debug APK into `apks/`**

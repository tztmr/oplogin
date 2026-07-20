# Android APK

这个目录是基于 `/oplogin` 页面做的偏离线安卓壳。

## 包名在哪里改

先改这 4 处，包名就能换掉：

1. `android-app/app/build.gradle`
   - `namespace 'com.tencent.mobileqq'`
   - `applicationId 'com.tencent.mobileqq'`
2. `android-app/app/src/main/java/com/dongpeng/oplogin/MainActivity.java`
   - 顶部 `package com.tencent.mobileqq;`
3. `android-app/app/src/main/java/com/dongpeng/oplogin/OpLoginBridge.java`
   - 顶部 `package com.tencent.mobileqq;`
4. `android-app/app/src/main/java/com/dongpeng/oplogin/OpWakeUrlBuilder.java`
   - 顶部 `package com.tencent.mobileqq;`

改完之后，还要把 Java 目录一起改掉：

- 从 `android-app/app/src/main/java/com/dongpeng/oplogin`
- 改成你的新包名对应的目录层级

例如你想改成 `com.example.demo`，就把目录改成：

- `android-app/app/src/main/java/com/example/demo`

## 怎么构建

如果已经生成了 Gradle wrapper：

```bash
cd android-app
./gradlew --offline assembleDebug
```

如果没有 wrapper，也可以直接用本机已有的 Gradle：

```bash
/Users/edking/.gradle/wrapper/dists/gradle-9.3.1-bin/23ovyewtku6u96viwx3xl3oks/gradle-9.3.1/bin/gradle --offline assembleDebug
```

默认调试包输出在：

- `android-app/app/build/outputs/apk/debug/app-debug.apk`

建议再复制一份到工作区根目录的 `apks/` 目录，方便直接拿包。

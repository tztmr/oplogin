package com.tencent.open.agent;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.regex.Pattern;

public class AgentActivity extends Activity {
    
    private String appId;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // 获取游戏传过来的 appid
        if (getIntent().getExtras() != null) {
            appId = getIntent().getExtras().getString("appid");
        }
        
        // 为了让你自己的界面（比如 MainActivity）能处理这个授权，我们通过 Intent 跳转过去
        // 把 appId 传过去
        try {
            Class<?> mainActivityClass = Class.forName("com.dongpeng.oplogin.MainActivity");
            Intent intent = new Intent(this, mainActivityClass);
            intent.putExtra("appid", appId);
            // 告诉 MainActivity 这是一个需要处理授权的请求
            intent.putExtra("is_auth_request", true);
            startActivityForResult(intent, 1000);
        } catch (ClassNotFoundException e) {
            e.printStackTrace();
            Toast.makeText(this, "找不到主界面", Toast.LENGTH_SHORT).show();
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 1000) {
            if (resultCode == RESULT_OK && data != null) {
                String opData = data.getStringExtra("op_data");
                if (opData != null && !opData.isEmpty()) {
                    beginIntoGame(opData);
                    return;
                }
            }
            // 如果用户取消了或者没传回数据，关闭代理界面
            finish();
        }
    }

    public static String trimSpaceTag(String str) {
        return Pattern.compile("\\s*|\t|\r|\n", 2).matcher(str).replaceAll("").trim();
    }

    public void beginIntoGame(String opData) {
        String cleanOp = trimSpaceTag(opData);
        String[] split = cleanOp.split("\\|");
        
        if (split.length == 5) {
            Intent intent = new Intent();
            JSONObject jsonObject = new JSONObject();
            try {
                jsonObject.putOpt("openid", split[0]);
                jsonObject.putOpt("access_token", split[1]);
                jsonObject.putOpt("pay_token", split[2]);
                jsonObject.putOpt("pfkey", split[3]);
                jsonObject.putOpt("auth_time", split[4]);
                jsonObject.putOpt("expires_in", "7776000"); // 90天过期
                jsonObject.putOpt("ret", "0");
                jsonObject.putOpt("pf", "desktop_m_qq-10000144-android-2002-");
                jsonObject.putOpt("page_type", "1");
                jsonObject.putOpt("expires_time", split[4]);
            } catch (JSONException e) {
                e.printStackTrace();
            }
            
            // 把伪造好的登录态返回给发起请求的游戏
            intent.putExtra("key_response", jsonObject.toString());
            setResult(RESULT_OK, intent);
            finish(); 
        } else {
            Toast.makeText(this, "OP数据格式错误", Toast.LENGTH_SHORT).show();
            finish();
        }
    }
}

package com.tencent.mobileqq;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {

    private EditText edtOpData;
    private Button btnLogin;
    private TextView tvStatus;
    
    private boolean isAuthRequest = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        edtOpData = findViewById(R.id.edt_op_data);
        btnLogin = findViewById(R.id.btn_login);
        tvStatus = findViewById(R.id.tv_status);

        checkIntent(getIntent());

        btnLogin.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String opData = edtOpData.getText().toString().trim();
                
                if (opData.isEmpty()) {
                    Toast.makeText(MainActivity.this, "OP数据不能为空", Toast.LENGTH_SHORT).show();
                    return;
                }

                if (isAuthRequest) {
                    // 如果是从游戏跳过来的授权请求，返回给 AgentActivity
                    Intent resultIntent = new Intent();
                    resultIntent.putExtra("op_data", opData);
                    setResult(RESULT_OK, resultIntent);
                    finish();
                } else {
                    // 如果是普通打开（没走授权流程），提示一下
                    Toast.makeText(MainActivity.this, "请先在游戏中点击QQ登录调起本程序", Toast.LENGTH_LONG).show();
                }
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        checkIntent(intent);
    }

    private void checkIntent(Intent intent) {
        if (intent != null) {
            isAuthRequest = intent.getBooleanExtra("is_auth_request", false);
            String appId = intent.getStringExtra("appid");
            
            if (isAuthRequest) {
                tvStatus.setText("正在为游戏 (AppId: " + (appId != null ? appId : "未知") + ") 授权");
                tvStatus.setTextColor(0xFF00A5E4); // 蓝色
            } else {
                tvStatus.setText("请在游戏中点击QQ登录，等待跳转到此界面");
                tvStatus.setTextColor(0xFF666666); // 灰色
            }
        }
    }
}

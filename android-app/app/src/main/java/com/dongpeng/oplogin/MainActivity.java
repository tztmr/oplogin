package com.dongpeng.oplogin;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import com.tencent.mobileqq.R;

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

                performLogin(opData);
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
            } else {
                tvStatus.setText("请在游戏中点击QQ登录，\n等待跳转到此页面");
            }
        }
    }

    private void performLogin(final String opData) {
        // Show Loading Dialog
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        View loadingView = getLayoutInflater().inflate(R.layout.dialog_loading, null);
        builder.setView(loadingView);
        builder.setCancelable(false);
        final AlertDialog loadingDialog = builder.create();
        loadingDialog.getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        loadingDialog.show();

        // Simulate network/verification delay
        new Handler().postDelayed(new Runnable() {
            @Override
            public void run() {
                loadingDialog.dismiss();
                if (isAuthRequest) {
                    showSuccessDialog(opData);
                } else {
                    Toast.makeText(MainActivity.this, "请先在游戏中点击QQ登录调起本程序", Toast.LENGTH_LONG).show();
                }
            }
        }, 1500);
    }

    private void showSuccessDialog(final String opData) {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        View successView = getLayoutInflater().inflate(R.layout.dialog_success, null);
        builder.setView(successView);
        builder.setCancelable(false);
        final AlertDialog successDialog = builder.create();
        successDialog.getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        
        TextView tvToken = successView.findViewById(R.id.tv_token);
        String tokenSnippet = "Token: ";
        try {
            String[] parts = opData.split("\\|");
            if (parts.length > 1) {
                tokenSnippet += parts[1];
            } else {
                tokenSnippet += opData.substring(0, Math.min(opData.length(), 20)) + "...";
            }
        } catch (Exception e) {
            tokenSnippet += "Unknown";
        }
        tvToken.setText(tokenSnippet);

        Button btnOk = successView.findViewById(R.id.btn_dialog_ok);
        btnOk.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                successDialog.dismiss();
                Intent resultIntent = new Intent();
                resultIntent.putExtra("op_data", opData);
                setResult(RESULT_OK, resultIntent);
                finish();
            }
        });

        successDialog.show();
    }
}

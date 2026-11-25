package com.bybastos.benjamin;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int PERMISSION_REQUEST_CODE = 200;
    private static final int NOTIFICACOES_REQUEST_CODE = 201;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // CRÍTICO PARA O CAPACITOR: registerPlugin TEM DE SER CHAMADO ANTES DE super.onCreate()
        registerPlugin(BenjaminVoicePlugin.class);
        registerPlugin(BenjaminSharePlugin.class);
        registerPlugin(BenjaminSegurancaPlugin.class);
        super.onCreate(savedInstanceState);

        SegurancaCore.init(getApplicationContext());

        // Os botões de volume do telemóvel passam a mexer SEMPRE no volume de multimédia (STREAM_MUSIC), que é por onde o Benjamin fala.
        // Sem isto, com a app calada os botões mexem no toque/chamadas e o condutor julga que o volume está no máximo.
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{
                            Manifest.permission.RECORD_AUDIO,
                            Manifest.permission.MODIFY_AUDIO_SETTINGS
                    },
                    PERMISSION_REQUEST_CODE
            );
        } else {
            pedirNotificacoes();
        }
    }

    /** Android 13+: sem esta permissão a notificação do serviço em primeiro plano (e os alertas) não aparecem. */
    private void pedirNotificacoes() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        ActivityCompat.requestPermissions(
                this,
                new String[]{ Manifest.permission.POST_NOTIFICATIONS },
                NOTIFICACOES_REQUEST_CODE
        );
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // Os pedidos não podem ser simultâneos: depois do microfone vêm as notificações
        if (requestCode == PERMISSION_REQUEST_CODE) pedirNotificacoes();
    }

    @Override
    public void onStart() {
        super.onStart();
        SegurancaCore.visivel = true;
    }

    @Override
    public void onStop() {
        super.onStop();
        SegurancaCore.visivel = false;
        manterWebViewViva();
    }

    @Override
    public void onPause() {
        super.onPause();
        manterWebViewViva();
    }

    /**
     * Com o serviço de voz ativo, a página não pode ser suspensa: os temporizadores e o áudio do WebView
     * têm de continuar com o ecrã apagado ou com outra app à frente. O Capacitor pausa o WebView em onPause();
     * aqui voltamos a acordá-lo (o serviço em primeiro plano mantém o processo vivo).
     */
    private void manterWebViewViva() {
        if (!SegurancaCore.servicoAtivo || getBridge() == null) return;
        final WebView wv = getBridge().getWebView();
        if (wv == null) return;
        final Runnable acordar = new Runnable() {
            @Override
            public void run() {
                try {
                    wv.onResume();
                    wv.resumeTimers();
                } catch (RuntimeException e) {
                    // WebView já destruído: ignora
                }
            }
        };
        acordar.run();
        wv.postDelayed(acordar, 250);
        wv.postDelayed(acordar, 1500);
    }
}

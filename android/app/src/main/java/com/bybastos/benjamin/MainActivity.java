package com.bybastos.benjamin;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int PERMISSION_REQUEST_CODE = 200;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // CRÍTICO PARA O CAPACITOR: registerPlugin TEM DE SER CHAMADO ANTES DE super.onCreate()
        registerPlugin(BenjaminVoicePlugin.class);
        super.onCreate(savedInstanceState);

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
        }
    }
}
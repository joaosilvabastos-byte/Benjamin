package com.bybastos.benjamin;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Receção e abertura de ficheiros partilhados de outras apps (WhatsApp, Ficheiros, Gmail...).
 */
@CapacitorPlugin(name = "BenjaminShare")
public class BenjaminSharePlugin extends Plugin {

    private static final String TAG = "BenjaminShare";
    private static final String EXTRA_TRATADO = "benjamin_partilha_tratada";
    private static final long MAX_BYTES = 8L * 1024 * 1024;

    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final Map<Integer, JSObject> pendentes = new LinkedHashMap<>();
    private int proximoId = 1;

    @Override
    public void load() {
        super.load();
        if (getActivity() != null) tratar(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        tratar(intent);
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        exec.shutdown();
    }

    @SuppressWarnings("deprecation")
    private void tratar(Intent intent) {
        if (intent == null) return;
        String acao = intent.getAction();
        if (!Intent.ACTION_SEND.equals(acao) && !Intent.ACTION_SEND_MULTIPLE.equals(acao)
                && !Intent.ACTION_VIEW.equals(acao)) return;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        if (intent.getBooleanExtra(EXTRA_TRATADO, false)) return;
        intent.putExtra(EXTRA_TRATADO, true);

        final String tipoIntent = intent.getType();
        final List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(acao)) {
            Uri d = intent.getData();
            if (d != null) uris.add(d);
        } else if (Intent.ACTION_SEND.equals(acao)) {
            Uri u = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                    : (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else {
            ArrayList<Uri> lista = Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                    : intent.<Uri>getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (lista != null) uris.addAll(lista);
        }
        if (uris.isEmpty()) {
            ClipData cd = intent.getClipData();
            if (cd != null) {
                for (int i = 0; i < cd.getItemCount(); i++) {
                    Uri u = cd.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            }
        }
        if (uris.isEmpty()) return;

        exec.execute(new Runnable() {
            @Override
            public void run() {
                for (Uri uri : uris) {
                    JSObject o = ler(uri, tipoIntent);
                    synchronized (pendentes) {
                        int id = proximoId++;
                        o.put("id", id);
                        pendentes.put(id, o);
                    }
                    notifyListeners("guiaPartilhada", o);
                }
            }
        });
    }

    @PluginMethod
    public void obterPartilhas(final PluginCall call) {
        exec.execute(new Runnable() {
            @Override
            public void run() {
                JSArray arr = new JSArray();
                synchronized (pendentes) {
                    for (JSObject o : pendentes.values()) arr.put(o);
                }
                JSObject r = new JSObject();
                r.put("itens", arr);
                call.resolve(r);
            }
        });
    }

    @PluginMethod
    public void confirmar(PluginCall call) {
        Integer id = call.getInt("id");
        if (id != null) {
            synchronized (pendentes) { pendentes.remove(id); }
        }
        call.resolve();
    }

    /**
     * abrirPdf(call)
     * Escreve os bytes Base64 num ficheiro temporário de cache e dispara o leitor de PDF nativo do Android.
     */
    @PluginMethod
    public void abrirPdf(final PluginCall call) {
        final String dados = call.getString("dados", "");
        final String nome = call.getString("nome", "guia_carga.pdf");
        if (dados == null || dados.trim().isEmpty()) {
            call.reject("Sem dados Base64");
            return;
        }

        exec.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    String base64Clean = dados;
                    if (dados.contains(",")) {
                        base64Clean = dados.split(",")[1];
                    }
                    byte[] pdfBytes = Base64.decode(base64Clean, Base64.DEFAULT);

                    String fileNameClean = (nome != null && !nome.trim().isEmpty()) ? nome.trim() : "guia_carga.pdf";
                    if (!fileNameClean.toLowerCase().endsWith(".pdf")) {
                        fileNameClean += ".pdf";
                    }

                    File cacheDir = getContext().getCacheDir();
                    File pdfFile = new File(cacheDir, fileNameClean);
                    FileOutputStream fos = new FileOutputStream(pdfFile);
                    fos.write(pdfBytes);
                    fos.flush();
                    fos.close();

                    Uri pdfUri = androidx.core.content.FileProvider.getUriForFile(
                            getContext(),
                            getContext().getPackageName() + ".fileprovider",
                            pdfFile
                    );

                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(pdfUri, "application/pdf");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

                    getContext().startActivity(intent);
                    call.resolve();
                } catch (Exception e) {
                    Log.e(TAG, "Erro ao abrir PDF nativo", e);
                    call.reject("Erro ao abrir PDF: " + e.getMessage());
                }
            }
        });
    }

    private JSObject ler(Uri uri, String tipoIntent) {
        JSObject o = new JSObject();
        ContentResolver cr = getContext().getContentResolver();
        String nome = nomeDe(cr, uri);
        String mime = null;
        try { mime = cr.getType(uri); } catch (RuntimeException e) { /* usa o do Intent */ }
        if (mime == null || mime.isEmpty() || "application/octet-stream".equals(mime)) mime = tipoIntent == null ? "" : tipoIntent;
        if (nome.toLowerCase().endsWith(".pdf")) mime = "application/pdf";
        o.put("nome", nome);
        o.put("mime", mime);

        if (!"application/pdf".equals(mime) && !mime.startsWith("image/")) {
            o.put("erro", "tipo");
            return o;
        }
        InputStream in = null;
        try {
            in = cr.openInputStream(uri);
            if (in == null) { o.put("erro", "leitura"); return o; }
            ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
            byte[] buf = new byte[32 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) != -1) {
                total += n;
                if (total > MAX_BYTES) { o.put("erro", "grande"); return o; }
                out.write(buf, 0, n);
            }
            o.put("dados", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "Falha a ler " + uri, e);
            o.put("erro", "leitura");
        } finally {
            if (in != null) { try { in.close(); } catch (IOException e) { /* ok */ } }
        }
        return o;
    }

    private String nomeDe(ContentResolver cr, Uri uri) {
        Cursor c = null;
        try {
            c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (RuntimeException e) {
            /* sem nome: usa o fim do caminho */
        } finally {
            if (c != null) c.close();
        }
        String p = uri.getLastPathSegment();
        return p == null ? "guia" : p;
    }
}

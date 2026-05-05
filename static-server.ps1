# Servidor HTTP estatico en el puerto 5500 (solo PowerShell, sin Node ni Python).
# Uso: carpeta del proyecto, o tarea de depuracion de VS Code / Cursor.
$ErrorActionPreference = 'Stop'
$port = 5500
$root = (Resolve-Path $PSScriptRoot).Path
$prefix = "http://127.0.0.1:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "No se pudo abrir $prefix (puerto en uso o permisos). Error: $_"
  exit 1
}

# Texto que usa .vscode/tasks.json (problemMatcher) para saber que ya hay servidor
Write-Host "Serving HTTP on $prefix"
Write-Host "Root: $root"

function Get-Mime([string] $ext) {
  switch ($ext.ToLower()) {
    '.html' { 'text/html; charset=utf-8' }
    '.htm' { 'text/html; charset=utf-8' }
    '.css' { 'text/css; charset=utf-8' }
    '.js' { 'application/javascript; charset=utf-8' }
    '.json' { 'application/json; charset=utf-8' }
    '.mjs' { 'application/javascript; charset=utf-8' }
    '.png' { 'image/png' }
    '.jpg' { 'image/jpeg' }
    '.jpeg' { 'image/jpeg' }
    '.gif' { 'image/gif' }
    '.svg' { 'image/svg+xml' }
    '.ico' { 'image/x-icon' }
    '.woff' { 'font/woff' }
    '.woff2' { 'font/woff2' }
    '.map' { 'application/json' }
    default { 'application/octet-stream' }
  }
}

# No usar "$root\" al final: en PowerShell la \ antes de " rompe el analisis de cadenas.
$rootNorm = if ($root.EndsWith('\')) { $root } else { $root + '\' }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $pathPart = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrEmpty($pathPart)) { $pathPart = 'index.html' }
    $pathPart = $pathPart -replace '/', [IO.Path]::DirectorySeparatorChar

    $full = [IO.Path]::GetFullPath((Join-Path $root $pathPart))
    if (-not $full.StartsWith($rootNorm, [StringComparison]::OrdinalIgnoreCase)) {
      $res.StatusCode = 403
      $b = [Text.Encoding]::UTF8.GetBytes('Forbidden')
      $res.OutputStream.Write($b, 0, $b.Length)
      $res.Close()
      continue
    }

    if (Test-Path $full -PathType Container) {
      $idx = Join-Path $full 'index.html'
      if (Test-Path $idx) { $full = $idx }
      else {
        $res.StatusCode = 404
        $b = [Text.Encoding]::UTF8.GetBytes('Not found')
        $res.OutputStream.Write($b, 0, $b.Length)
        $res.Close()
        continue
      }
    }

    if (-not (Test-Path $full -PathType Leaf)) {
      $res.StatusCode = 404
      $b = [Text.Encoding]::UTF8.GetBytes('Not found')
      $res.OutputStream.Write($b, 0, $b.Length)
      $res.Close()
      continue
    }

    $ext = [IO.Path]::GetExtension($full)
    $bytes = [IO.File]::ReadAllBytes($full)
    $res.ContentType = Get-Mime $ext
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  }
  catch {
    try {
      $res.StatusCode = 500
      $b = [Text.Encoding]::UTF8.GetBytes('Server error')
      $res.OutputStream.Write($b, 0, $b.Length)
    } catch { }
  }
  finally {
    $res.Close()
  }
}

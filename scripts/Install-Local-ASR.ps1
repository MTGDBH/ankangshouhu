[CmdletBinding()]
param([string]$PythonPath = '')

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ModelRoot = Join-Path $ProjectRoot 'ml\models\asr'
$VenvPython = Join-Path $ModelRoot '.venv\Scripts\python.exe'

if (-not $PythonPath) {
  $Candidates = & py -0p 2>$null
  foreach ($Version in @('3.13', '3.12')) {
    foreach ($Line in $Candidates) {
      if ($Line -match "3\.$($Version.Split('.')[1]).*?([A-Za-z]:\\.*python\.exe)\s*$") {
        $PythonPath = $Matches[1]
        break
      }
    }
    if ($PythonPath) { break }
  }
}
if (-not $PythonPath -or -not (Test-Path -LiteralPath $PythonPath)) {
  throw '本机语音识别需要 Python 3.12 或 3.13。请安装后用 -PythonPath 指定 python.exe。'
}
$Version = & $PythonPath -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
if ($Version.Trim() -notin @('3.12', '3.13')) { throw '本机语音识别需要 Python 3.12 或 3.13。' }

New-Item -ItemType Directory -Path $ModelRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $VenvPython)) {
  & $PythonPath -m venv (Join-Path $ModelRoot '.venv')
  if ($LASTEXITCODE -ne 0) { throw '创建本机语音识别环境失败。' }
}
& $VenvPython -m pip install --disable-pip-version-check -r (Join-Path $ProjectRoot 'ml\requirements-asr.txt')
if ($LASTEXITCODE -ne 0) { throw '安装本机语音识别依赖失败。' }

$Repo = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'
$Assets = @(
  @{ Name = 'model.int8.onnx'; Sha256 = 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  @{ Name = 'tokens.txt'; Sha256 = 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' }
)
foreach ($Asset in $Assets) {
  $Path = Join-Path $ModelRoot $Asset.Name
  if ((Test-Path -LiteralPath $Path) -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Asset.Sha256) {
    Write-Host "已校验 $($Asset.Name)"
    continue
  }
  $Download = "$Path.download"
  Invoke-WebRequest -Uri "$Repo/$($Asset.Name)?download=true" -OutFile $Download -MaximumRedirection 5
  if ((Get-FileHash -LiteralPath $Download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Asset.Sha256) {
    Remove-Item -LiteralPath $Download -ErrorAction SilentlyContinue
    throw "$($Asset.Name) 校验失败。"
  }
  Move-Item -LiteralPath $Download -Destination $Path -Force
  Write-Host "已安装 $($Asset.Name)"
}

& $VenvPython -c 'import sherpa_onnx, numpy; print("本机普通话识别已就绪")'
if ($LASTEXITCODE -ne 0) { throw '本机语音识别环境自检失败。' }

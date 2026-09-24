[CmdletBinding()]
param([string]$PythonPath = '')

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VoiceRoot = Join-Path $ProjectRoot 'ml\models\tts'
$VenvPython = Join-Path $VoiceRoot '.venv\Scripts\python.exe'
$Requirements = Join-Path $ProjectRoot 'ml\requirements-voice.txt'

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
  throw '本机语音需要 Python 3.12 或 3.13。请安装后用 -PythonPath 指定 python.exe。'
}
$Version = & $PythonPath -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
if ($Version.Trim() -notin @('3.12', '3.13')) { throw '本机语音需要 Python 3.12 或 3.13。' }

New-Item -ItemType Directory -Path $VoiceRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $VenvPython)) {
  & $PythonPath -m venv (Join-Path $VoiceRoot '.venv')
  if ($LASTEXITCODE -ne 0) { throw '创建本机语音环境失败。' }
}
& $VenvPython -m pip install --disable-pip-version-check -r $Requirements
if ($LASTEXITCODE -ne 0) { throw '安装本机语音依赖失败。' }

$Assets = @(
  @{
    Name = 'kokoro-v1.1-zh.fp16.onnx'
    Sha256 = 'a628ea5d6fbde96d1a85f691a6a00847829937f9e488021ba2c5359bc6ea08b5'
  },
  @{
    Name = 'voices-v1.1-zh.bin'
    Sha256 = '14cb6186c99e4f6016871405f62046c5df863ae27465cbdc4ee08be7dd703acd'
  }
)
foreach ($Asset in $Assets) {
  $Path = Join-Path $VoiceRoot $Asset.Name
  if ((Test-Path -LiteralPath $Path) -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Asset.Sha256) {
    Write-Host "已校验 $($Asset.Name)"
    continue
  }
  $Download = "$Path.download"
  $Url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/$($Asset.Name)"
  Invoke-WebRequest -Uri $Url -OutFile $Download -MaximumRedirection 5
  if ((Get-FileHash -LiteralPath $Download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Asset.Sha256) {
    Remove-Item -LiteralPath $Download -ErrorAction SilentlyContinue
    throw "$($Asset.Name) 校验失败。"
  }
  Move-Item -LiteralPath $Download -Destination $Path -Force
  Write-Host "已安装 $($Asset.Name)"
}

& $VenvPython -c 'from kokoro_onnx import Kokoro; from misaki import zh; import soundfile; assert zh.ZHG2P(version="1.1")'
if ($LASTEXITCODE -ne 0) { throw '本机语音环境自检失败。' }
Write-Host '本机自然语音已就绪，重启服务后即可在移动端朗读。'

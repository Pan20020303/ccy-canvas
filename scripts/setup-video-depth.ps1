param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "ccy-canvas"),
    [string]$PythonCommand = "python"
)

$ErrorActionPreference = "Stop"
$repoDir = Join-Path $InstallRoot "Video-Depth-Anything"
$runner = Join-Path $repoDir "run.py"
$venvPython = Join-Path $repoDir ".venv\Scripts\python.exe"
$checkpointDir = Join-Path $repoDir "checkpoints"
$checkpoint = Join-Path $checkpointDir "video_depth_anything_vits.pth"
$checkpointUrl = "https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/video_depth_anything_vits.pth"

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
if (-not (Test-Path -LiteralPath $repoDir)) {
    git clone --depth 1 https://github.com/DepthAnything/Video-Depth-Anything.git $repoDir
} elseif (-not (Test-Path -LiteralPath $runner)) {
    throw "Existing install directory does not contain run.py: $repoDir"
}

if (-not (Test-Path -LiteralPath $venvPython)) {
    $python = Get-Command $PythonCommand -ErrorAction Stop
    & $python.Source -m venv (Join-Path $repoDir ".venv")
}

& $venvPython -m pip install --upgrade pip
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    # PyPI's Windows torch wheel is CPU-only. Install the matching official
    # CUDA wheel first; the repository's torch==2.1.1 requirement then keeps it.
    $cudaReady = (& $venvPython -c "import torch; print(str(torch.cuda.is_available()).lower())" 2>$null | Select-Object -Last 1)
    if ($cudaReady -ne "true") {
        & $venvPython -m pip install --upgrade --force-reinstall torch==2.1.1 torchvision==0.16.1 --index-url https://download.pytorch.org/whl/cu121
    }
}
& $venvPython -m pip install -r (Join-Path $repoDir "requirements.txt")

New-Item -ItemType Directory -Force -Path $checkpointDir | Out-Null
if (-not (Test-Path -LiteralPath $checkpoint)) {
    Invoke-WebRequest -UseBasicParsing -Uri $checkpointUrl -OutFile $checkpoint
}

[Environment]::SetEnvironmentVariable("VIDEO_DEPTH_ANYTHING_DIR", $repoDir, "User")
[Environment]::SetEnvironmentVariable("VIDEO_DEPTH_PYTHON", $venvPython, "User")
$env:VIDEO_DEPTH_ANYTHING_DIR = $repoDir
$env:VIDEO_DEPTH_PYTHON = $venvPython

Write-Host "Video Depth Anything Small is ready."
Write-Host "VIDEO_DEPTH_ANYTHING_DIR=$repoDir"
Write-Host "Restart the CCY Canvas backend before using Depth motion."

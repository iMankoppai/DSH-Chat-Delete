# 一键部署：把本项目的 lib/*.js 同步到 DSH 正在使用的那两份安装副本。
# 用法（在项目根或任意位置）：
#   pwsh -File scripts\sync-deploy.ps1
# 或双击 scripts\sync-deploy.cmd

param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$lib = Join-Path $project 'lib'
if (-not (Test-Path -LiteralPath $lib)) { throw "找不到 lib 目录: $lib" }

$profileRoot = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$targets = @(
  (Join-Path $profileRoot 'local\dsh-session-cleaner\lib'),
  (Join-Path $profileRoot 'node_modules\dsh-session-cleaner\lib')
)
foreach ($t in $targets) {
  if (-not (Test-Path -LiteralPath $t)) { throw "安装目录不存在（插件是否已安装？）: $t" }
}

$files = Get-ChildItem -LiteralPath $lib -Filter *.js -File
if ($files.Count -eq 0) { throw "lib 下没有 js 文件" }

foreach ($f in $files) {
  & node --check $f.FullName
  if ($LASTEXITCODE -ne 0) { throw "语法检查失败: $($f.Name)" }
}

$extras = @("package.json", "cordis.patch.yml") |
  ForEach-Object { Join-Path $project $_ } |
  Where-Object { Test-Path -LiteralPath $_ }

foreach ($t in $targets) {
  foreach ($f in $files) {
    Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $t $f.Name) -Force
  }
  $parent = Split-Path $t -Parent
  foreach ($f in $extras) {
    Copy-Item -LiteralPath $f -Destination (Join-Path $parent (Split-Path $f -Leaf)) -Force
  }
}

if (-not $Quiet) {
  foreach ($f in $files) {
    $hash = (Get-FileHash -LiteralPath $f.FullName).Hash.Substring(0, 10)
    Write-Host ("同步 {0}  {1}" -f $f.Name, $hash)
  }
  Write-Host ""
  Write-Host "已同步到："
  foreach ($t in $targets) { Write-Host "  $t" }
  Write-Host ""
  Write-Host "下一步：完全退出 DSH 再重新打开（只刷新页面不够）。" -ForegroundColor Yellow
}

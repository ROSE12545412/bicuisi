# 碧翠丝的禁书库 / scripts/decode-to-bmp.ps1
# ---------------------------------------------------------------------------
# 把任意常见图片格式（JPG/PNG/WebP/GIF/BMP）解码成无压缩 32 位 BMP。
#
# 为什么需要这一步：Node **没有任何内置图像解码能力**（实测 Node 24 里
# `ImageDecoder` / `node:image` / `createImageBitmap` 全部不存在）。
# 而抠图只需要像素，不需要解码器 —— 所以解码交给 Windows 自带的 GDI+，
# 抠图与编码留给 Node（见 cutout.js）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/decode-to-bmp.ps1 <输入图> <输出bmp>

param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $InputPath)) { throw "找不到输入文件：$InputPath" }

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path $InputPath).Path)
try {
    Write-Output "解码 $($src.Width)x$($src.Height)  源像素格式 $($src.PixelFormat)"

    # 统一画到 32bppArgb 上：这样无论源图是什么格式，输出都是可直接读的 RGBA
    $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
        } finally { $g.Dispose() }

        $bmp.Save((Join-Path (Get-Location) $OutputPath), [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally { $bmp.Dispose() }
} finally { $src.Dispose() }

$out = Get-Item $OutputPath
Write-Output "已写出 $OutputPath（$([math]::Round($out.Length / 1KB, 1)) KB）"

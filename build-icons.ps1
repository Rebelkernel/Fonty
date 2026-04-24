# Rasterize the system-tray / taskbar / window logo (Frame 42 variant)
# to a 1024x1024 PNG, then hand that PNG to `tauri icon` to regenerate
# the app-icon files. Not used for the UI logos in the top bar — those
# stay on Frame 40 / Frame 41 swapping by theme.
Add-Type -AssemblyName System.Drawing
$size = 1024
# Source SVG is 31x31 with a 30.0529 bg rect (small border offset).
$scale = $size / 30.0529
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$bg = [System.Drawing.Color]::FromArgb(255, 32, 32, 32)
$bgBrush = New-Object System.Drawing.SolidBrush($bg)
$radius = [int]([Math]::Round(3.75661 * $scale))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90)
$path.AddArc($size - $radius * 2, 0, $radius * 2, $radius * 2, 270, 90)
$path.AddArc($size - $radius * 2, $size - $radius * 2, $radius * 2, $radius * 2, 0, 90)
$path.AddArc(0, $size - $radius * 2, $radius * 2, $radius * 2, 90, 90)
$path.CloseFigure()
$g.FillPath($bgBrush, $path)
$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
# Rectangles extracted from Frame 42.svg path data (x1,y1,x2,y2).
$rects = @(
  @(14.1427, 3.41962, 16.2179, 5.53),
  @(17.66,   3.41962, 19.7352, 5.53),
  @(10.6254, 6.93693, 12.7006, 9.04732),
  @(21.1773, 6.93693, 23.2525, 9.04732),
  @(10.6254, 10.4542, 12.7006, 12.5646),
  @(7.10808, 13.9716, 9.18329, 16.0819),
  @(10.6254, 13.9716, 12.7006, 16.0819),
  @(14.1427, 13.9716, 16.2179, 16.0819),
  @(17.66,   13.9716, 19.7352, 16.0819),
  @(10.6254, 17.4889, 12.7006, 19.5993),
  @(10.6254, 21.0062, 12.7006, 23.1166),
  @(10.6254, 24.5235, 12.7006, 26.6339)
)
foreach ($r in $rects) {
  $x = $r[0] * $scale
  $y = $r[1] * $scale
  $w = ($r[2] - $r[0]) * $scale
  $h = ($r[3] - $r[1]) * $scale
  $g.FillRectangle($whiteBrush, $x, $y, $w, $h)
}
$out = 'C:\Users\Adria\Desktop\FONTY\icon-source.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "Wrote $out"

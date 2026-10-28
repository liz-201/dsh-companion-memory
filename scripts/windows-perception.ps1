param(
  [ValidateSet('windows','uia','image')][string]$Mode='windows',
  [long]$WindowId=0,
  [int]$ExpectedProcessId=0,
  [string]$ExpectedProcessName='',
  [string]$ExpectedStartedAt=''
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase,System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class CompanionWindowProbe {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
  [DllImport("user32.dll")] static extern bool PhysicalToLogicalPointForPerMonitorDPI(IntPtr hwnd,ref Point point);
  public static void UsePhysicalCoordinates(){SetThreadDpiAwarenessContext(new IntPtr(-4));}
  public delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr arg);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public class Window { public long windowId; public int processId; public string app; public string startedAt; public bool foreground; public bool minimized; }
  public static Window Describe(long id) {
    IntPtr h=new IntPtr(id); uint pid; GetWindowThreadProcessId(h,out pid);
    if(pid==0 || !IsWindowVisible(h)) throw new Exception("window-unavailable");
    Process p=Process.GetProcessById((int)pid);
    return new Window{windowId=id,processId=(int)pid,app=p.ProcessName,startedAt=p.StartTime.ToUniversalTime().Ticks.ToString(),foreground=h==GetForegroundWindow(),minimized=IsIconic(h)};
  }
  public static Window[] Windows() {
    var result=new List<Window>();
    EnumWindows((h,a)=>{if(result.Count>=100)return false;try{result.Add(Describe(h.ToInt64()));}catch{}return true;},IntPtr.Zero);
    return result.ToArray();
  }
  public static byte[] Image(long id,double[][] masks) {
    IntPtr h=new IntPtr(id);Rect r;
    // PrintWindow renders in the target's DPI coordinate space. UIA reports physical pixels.
    SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(h));
    if(IsIconic(h)||!GetWindowRect(h,out r))throw new Exception("window-not-capturable");
    int w=r.Right-r.Left,ht=r.Bottom-r.Top;
    if(w<2||ht<2||w>6000||ht>4000)throw new Exception("window-size-out-of-range");
    using(var bmp=new Bitmap(w,ht)) {
      using(var g=Graphics.FromImage(bmp)) {
        var dc=g.GetHdc();bool ok;try{ok=PrintWindow(h,dc,2);}finally{g.ReleaseHdc(dc);}
        if(!ok)throw new Exception("window-capture-unsupported");
        foreach(var mask in masks){
          var first=new Point{X=(int)Math.Floor(mask[0]),Y=(int)Math.Floor(mask[1])};
          var last=new Point{X=(int)Math.Ceiling(mask[0]+mask[2]),Y=(int)Math.Ceiling(mask[1]+mask[3])};
          if(!PhysicalToLogicalPointForPerMonitorDPI(h,ref first)||!PhysicalToLogicalPointForPerMonitorDPI(h,ref last))throw new Exception("redaction-coordinate-unavailable");
          g.FillRectangle(Brushes.Black,first.X-r.Left-3,first.Y-r.Top-3,last.X-first.X+6,last.Y-first.Y+6);
        }
      }
      int tw=Math.Min(1920,w),th=Math.Max(1,(int)((double)ht*tw/w));
      using(var resized=new Bitmap(bmp,new Size(tw,th)))using(var stream=new MemoryStream()){resized.Save(stream,ImageFormat.Png);return stream.ToArray();}
    }
  }
}
'@
function Wait-WinRt($Operation,[Type]$ResultType) {
  $method=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 } | Select-Object -First 1
  $task=$method.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
  if(-not $task.Wait(3000)){throw 'ocr-timeout'}
  return $task.Result
}
try {
  [CompanionWindowProbe]::UsePhysicalCoordinates()
  if($Mode -eq 'windows') { @{windows=@([CompanionWindowProbe]::Windows())} | ConvertTo-Json -Depth 5 -Compress; exit }
  $window=[CompanionWindowProbe]::Describe($WindowId)
  if($window.processId -ne $ExpectedProcessId -or $window.app -cne $ExpectedProcessName -or $window.startedAt -cne $ExpectedStartedAt){throw 'window-identity-changed'}
  $root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowId)
  $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue=New-Object 'System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]'
  $queue.Enqueue($root)
  $facts=New-Object 'System.Collections.Generic.List[object]'
  $masks=New-Object 'System.Collections.Generic.List[double[]]'
  $visited=0;$chars=0
  while($queue.Count -gt 0 -and $visited -lt 200 -and $chars -lt 8000) {
    $node=$queue.Dequeue();$visited++
    try {
      $current=$node.Current
      # Some WinForms providers do not mark password edits reliably. Exclude all edit controls.
      if($current.IsPassword -or $current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $current.ClassName -match '(?i)edit|password|textbox'){$b=$current.BoundingRectangle;$masks.Add(@($b.X,$b.Y,$b.Width,$b.Height));continue}
      if($Mode -eq 'uia' -and -not $current.IsOffscreen -and $current.Name){
        $text=$current.Name.Substring(0,[Math]::Min(400,$current.Name.Length));$chars+=$text.Length
        $facts.Add(@{text=$text;source='uia';control=$current.ControlType.ProgrammaticName})
      }
      $child=$walker.GetFirstChild($node)
      while($null -ne $child -and $queue.Count -lt 200){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
    }catch{}
  }
  if($Mode -eq 'uia') { @{window=$window;facts=@($facts.ToArray());truncated=($visited -ge 200 -or $chars -ge 8000)} | ConvertTo-Json -Depth 7 -Compress;exit }
  $bytes=[CompanionWindowProbe]::Image($WindowId,$masks.ToArray())
  if($bytes.Length -gt 4194304){throw 'image-too-large'}
  $ocrText='';$ocrError=$null
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
    $null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
    $null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $stream=New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer=New-Object Windows.Storage.Streams.DataWriter($stream)
    $writer.WriteBytes($bytes);$null=Wait-WinRt $writer.StoreAsync() ([uint32]);$writer.DetachStream() | Out-Null;$stream.Seek(0)
    $decoder=Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap=Wait-WinRt $decoder.GetSoftwareBitmapAsync() ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if($null -eq $engine){throw 'ocr-language-unavailable'}
    $recognized=Wait-WinRt $engine.RecognizeAsync($bitmap) ([Windows.Media.Ocr.OcrResult])
    $ocrText=$recognized.Text.Substring(0,[Math]::Min(8000,$recognized.Text.Length))
    if($ocrText){$facts.Add(@{text=$ocrText;source='ocr';control='window-image'})}
    $bitmap.Dispose();$stream.Dispose()
  }catch{$ocrError='ocr-unavailable'}
  @{window=$window;facts=@($facts.ToArray());image=[Convert]::ToBase64String($bytes);mediaType='image/png';ocrError=$ocrError;maskedControls=$masks.Count} | ConvertTo-Json -Depth 7 -Compress
}catch{
  @{error='probe-unavailable';reason=$_.Exception.Message.Substring(0,[Math]::Min(180,$_.Exception.Message.Length))} | ConvertTo-Json -Compress
  exit 1
}

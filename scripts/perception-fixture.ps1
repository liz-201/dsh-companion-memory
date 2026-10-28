param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$form=New-Object System.Windows.Forms.Form
$form.Text='Companion native fixture';$form.Width=640;$form.Height=360
$form.ShowInTaskbar=$false;$form.StartPosition='Manual';$form.Location=New-Object System.Drawing.Point(40,40)
$label=New-Object System.Windows.Forms.Label
$label.Text='Companion fixture: Build failed 42';$label.AccessibleName=$label.Text;$label.AutoSize=$true;$label.Location=New-Object System.Drawing.Point(30,30)
$label.Font=New-Object System.Drawing.Font('Arial',18)
$form.Controls.Add($label)
$password=New-Object System.Windows.Forms.TextBox
$password.UseSystemPasswordChar=$true;$password.Text='fixture-secret-7291';$password.Location=New-Object System.Drawing.Point(30,90)
$form.Controls.Add($password)
$timer=New-Object System.Windows.Forms.Timer
$timer.Interval=30000;$timer.Add_Tick({$form.Close()});$timer.Start()
$form.Add_Shown({@{windowId=$form.Handle.ToInt64();processId=$PID;app='powershell';startedAt=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString();foreground=$false;minimized=$false}|ConvertTo-Json -Compress|Set-Content -LiteralPath $OutputPath -Encoding UTF8})
[System.Windows.Forms.Application]::Run($form)

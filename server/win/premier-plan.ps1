# Amene au premier plan la fenetre de l'Explorateur ouverte sur un dossier.
#
# Windows n'accorde le premier plan qu'au processus qui vient de recevoir une
# entree clavier ou souris. Le serveur de CutLocal tourne en arriere-plan : sa
# fenetre s'ouvrirait derriere l'application, et l'utilisateur ne verrait rien
# se passer. On lui redonne donc ce droit en trois temps, du plus propre au
# plus insistant, en s'arretant des que la fenetre est devant.
param([Parameter(Mandatory=$true)][string]$Dossier)

Add-Type @'
using System; using System.Runtime.InteropServices;
public class Av {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr x);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@

$cible = [IO.Path]::GetFullPath($Dossier).TrimEnd('\')
$hwnd = [IntPtr]::Zero

# L'Explorateur met un instant a enregistrer sa nouvelle fenetre.
for ($i = 0; $i -lt 25 -and $hwnd -eq [IntPtr]::Zero; $i++) {
  try {
    $shell = New-Object -ComObject Shell.Application
    foreach ($f in @($shell.Windows())) {
      try {
        $p = $f.Document.Folder.Self.Path.TrimEnd('\')
        if ($p -eq $cible) { $hwnd = [IntPtr]$f.HWND; break }
      } catch {}
    }
  } catch {}
  if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($hwnd -eq [IntPtr]::Zero) { exit 1 }

function Devant { return ([Av]::GetForegroundWindow() -eq $hwnd) }

[void][Av]::ShowWindow($hwnd, 9)   # SW_RESTORE : deplie si la fenetre etait reduite
[void][Av]::BringWindowToTop($hwnd)
[void][Av]::SetForegroundWindow($hwnd)
if (Devant) { exit 0 }

# 2) Emprunter la file d'entree du thread qui a le focus.
$moi = [Av]::GetCurrentThreadId()
$devant = [Av]::GetWindowThreadProcessId([Av]::GetForegroundWindow(), [IntPtr]::Zero)
if ($devant -ne 0 -and $devant -ne $moi) {
  if ([Av]::AttachThreadInput($devant, $moi, $true)) {
    [void][Av]::SetForegroundWindow($hwnd)
    [void][Av]::AttachThreadInput($devant, $moi, $false)
  }
}
if (Devant) { exit 0 }

# 3) Une pression sur ALT compte comme une entree utilisateur : elle rend au
# processus le droit de passer devant. SwitchToThisWindow finit le travail.
[void][Av]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
[void][Av]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)   # KEYEVENTF_KEYUP
[void][Av]::SetForegroundWindow($hwnd)
if (-not (Devant)) { [Av]::SwitchToThisWindow($hwnd, $true) }

if (Devant) { exit 0 } else { exit 2 }

using System.Reflection;
using SIPSorcery.Net;

string P(ParameterInfo p) => p.ParameterType.Name + " " + p.Name;

void DumpType(System.Type? t, string[] nameFilter)
{
    if (t is null) { System.Console.WriteLine("(null type)"); return; }
    System.Console.WriteLine($"### {t.FullName}");
    foreach (var m in t.GetMembers(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
    {
        if (nameFilter.Length > 0 && !nameFilter.Any(f => m.Name.Contains(f, System.StringComparison.OrdinalIgnoreCase))) continue;
        switch (m)
        {
            case MethodInfo mi when !mi.IsSpecialName:
                System.Console.WriteLine($"  {mi.ReturnType.Name} {mi.Name}(" + string.Join(", ", mi.GetParameters().Select(P)) + ")");
                break;
            case PropertyInfo pi:
                System.Console.WriteLine($"  prop {pi.PropertyType.Name} {pi.Name}");
                break;
            case FieldInfo fi:
                System.Console.WriteLine($"  field {fi.FieldType.Name} {fi.Name}");
                break;
        }
    }
}

var asm = typeof(RTCPeerConnection).Assembly;
var pc = typeof(RTCPeerConnection);

// RTCPeerConnection + its base chain (RTPSession) — audio-stream related surface.
var t = pc;
while (t is not null && t != typeof(object))
{
    DumpType(t, new[] { "Audio", "Stream", "addTrack", "SendAudio" });
    t = t.BaseType;
}

DumpType(asm.GetExportedTypes().FirstOrDefault(x => x.Name == "AudioStream"), new[] { "Send", "LocalTrack", "Ssrc", "Index" });
DumpType(asm.GetExportedTypes().FirstOrDefault(x => x.Name == "MediaStream"), new[] { "Send", "LocalTrack", "Ssrc", "Index" });

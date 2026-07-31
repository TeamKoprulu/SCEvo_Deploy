$7zbin = "C:\Program Files\7-Zip\7z.exe"
$targetname = "SCEvo_CampaignMods_0_13.zip"
rm ..\Bin\Zip -recurse
mkdir ..\Bin\Zip
ls ..\Bin\Mods\*.SC2Mod -Recurse | %{
$filename = $_.name
& $7zbin "a" ..\Bin\Zip\$($targetname) $_.FullName  #| Out-Null
& $7zbin "rn" ..\Bin\Zip\$($targetname) $filename "Mods/SC Evolution Complete/SCEvo_CampaignMods/$($filename)" #| Out-Null
}

$targetname = "SCEvo_Maps_0_13.zip"
ls ..\Bin\Maps\Loomings\*.SC2Map | %{
$filename = $_.name
& $7zbin "a" ..\Bin\Zip\$($targetname) $_.FullName  #| Out-Null
& $7zbin "rn" ..\Bin\Zip\$($targetname) $filename "Loomings/$($filename)" #| Out-Null
}

ls ..\Bin\Maps\*.SC2Map | %{
$filename = $_.name
& $7zbin "a" ..\Bin\Zip\$($targetname) $_.FullName  #| Out-Null
}
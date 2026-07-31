"" > .\Build.mpq2k
rm ..\Bin\Mods\ -Recurse
rm ..\Bin\Maps\ -Recurse
mkdir ..\Bin\Mods\ 
mkdir ..\Bin\Maps\ 
mkdir ..\Bin\Maps\Loomings
ls ..\SCEvo_CampaignMods -Directory | %{

    $filename = $_.Name
    write-host $filename
    

    $src = "../bin/Mods/$($filename)"
    $target = "../SCEvo_CampaignMods/$($filename)/*"
    
    "new $src 1000" >>.\Build.mpq2k
    "add $src ../SCEvo_CampaignMods/$($filename)/* /r /c" >> .\Build.mpq2k
    "flush $src" >> .\Build.mpq2k
    
}


ls ..\SCEvo_Maps\Loomings -Directory | %{

    $filename = $_.Name
    write-host $filename
    

    $src = "../bin/Maps/Loomings/$($filename)"
    $target = "../SCEvo_Maps/Loomings/$($filename)/*"
    
    "new $src 1000" >>.\Build.mpq2k
    "add $src ../SCEvo_Maps/Loomings/$($filename)/* /r /c" >> .\Build.mpq2k
    "flush $src" >> .\Build.mpq2k
}


ls ..\SCEvo_Maps\*.SC2Map -Directory | %{

    $filename = $_.Name
    write-host $filename
    

    $src = "../bin/Maps/$($filename)"
    $target = "../SCEvo_Maps/$($filename)/*"
    
    "new $src 1000" >>.\Build.mpq2k
    "add $src ../SCEvo_Maps/$($filename)/* /r /c" >> .\Build.mpq2k
    "flush $src" >> .\Build.mpq2k
    
    
}


.\MPQEditor.exe console "Build.mpq2k"
#!/bin/bash

#pkg psiotclient.js --output amIotClient -t node10-macos-x64,node10-win-x64,node10-linux-x64

unameOut="$(uname -s)"
case "${unameOut}" in
    Linux*)     
	pkg psiotclient.js --output amIotClient -t node10-linux-x64
	;;
    Darwin*)    
	pkg psiotclient.js --output amIotClient -t node10-macos-x64
	;;
    CYGWIN*)
    pkg psiotclient.js --output amIotClient -t node10-win-x64
    ;;
    MINGW*)
	pkg psiotclient.js --output amIotClient -t node10-win-x64
	;;
    *)
esac





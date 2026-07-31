cmake_minimum_required(VERSION 3.16)

set(IDF_TARGET esp32s3 CACHE STRING "Hosty Cardputer target" FORCE)
file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/version.txt" PROJECT_VER LIMIT_COUNT 1)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(hosty_cardputer_shell)


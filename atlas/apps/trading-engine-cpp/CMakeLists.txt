cmake_minimum_required(VERSION 3.20)
project(AtlasTradingEngine VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Optimization flags for maximum performance
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native -mtune=native -flto -ffast-math")
    set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -funroll-loops -fprefetch-loop-arrays")
elseif(MSVC)
    set(CMAKE_CXX_FLAGS_RELEASE "/O2 /GL /arch:AVX2 /fp:fast")
endif()

# Find packages
find_package(Threads REQUIRED)
find_package(Boost 1.75 REQUIRED COMPONENTS system thread chrono)

# Include directories
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/include)
include_directories(${Boost_INCLUDE_DIRS})

# Add subdirectories
add_subdirectory(src)
add_subdirectory(benchmarks)

# Testing
enable_testing()
add_subdirectory(tests)

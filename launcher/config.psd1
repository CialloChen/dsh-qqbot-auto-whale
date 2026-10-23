@{
    # DSH 命令行工具。留空 = 自动查找（PATH → 默认安装目录）。
    DshPath        = ''

    # profile 名。
    Profile        = 'qqbot'

    # QQ bot 的工作目录。留空 = <%USERPROFILE%>\Documents\dsh-qqbot-workspace
    Workspace      = ''

    # NapCat 的一键启动批处理。留空 = 自动查找常见位置。
    NapCatLauncher = ''

    # QQ bot 专用 key 文件（一行，无引号）。留空 = <%USERPROFILE%>\.dsh\qqbot-deepseek.key
    KeyFile        = ''

    # 启动后等待端口就绪的秒数。
    HostWaitSeconds   = 60
    NapCatWaitSeconds = 60
}
